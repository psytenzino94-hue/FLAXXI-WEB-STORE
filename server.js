import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;
const DATA = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'uploads');
await fs.mkdir(DATA,{recursive:true}); await fs.mkdir(uploadDir,{recursive:true});

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use(rateLimit({windowMs:60_000,max:180,standardHeaders:true,legacyHeaders:false}));

const upload = multer({dest:uploadDir, limits:{fileSize: 2 * 1024 * 1024 * 1024}});
const r2Enabled = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
const s3 = r2Enabled ? new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}}) : null;

const F_DROID_INDEX = 'https://f-droid.org/repo/index-v1.json';
const F_DROID_BASE = 'https://f-droid.org/repo/';

async function readJson(name,fallback){try{return JSON.parse(await fs.readFile(path.join(DATA,name),'utf8'));}catch{return fallback;}}
async function writeJson(name,value){await fs.writeFile(path.join(DATA,name),JSON.stringify(value,null,2));}
async function apps(){return readJson('apps.json',[])}
async function announcements(){return readJson('announcements.json',[])}
async function botCandidates(){return readJson('bot_candidates.json',[])}
function sign(user){return jwt.sign({user,role:'admin'},process.env.JWT_SECRET||'dev-secret',{expiresIn:'8h'});}
function auth(req,res,next){const h=req.headers.authorization||''; if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'}); try{req.user=jwt.verify(h.slice(7),process.env.JWT_SECRET||'dev-secret');next()}catch{return res.status(401).json({error:'Invalid or expired token'})}}
function safeName(n){return String(n).replace(/[^a-zA-Z0-9._-]/g,'_').slice(-150)}
function slugify(n){return String(n).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)}
function categoryFrom(categories=[]){const s=Array.isArray(categories)?categories.join(' ').toLowerCase():String(categories).toLowerCase(); if(s.includes('game'))return 'Games'; if(s.includes('video'))return 'Video'; if(s.includes('social'))return 'Social'; if(s.includes('music'))return 'Music'; if(s.includes('security'))return 'Security'; return 'Apps'}

app.get('/api/health',(req,res)=>res.json({ok:true,storage:r2Enabled?'cloudflare-r2':'local-demo',bot:'fdroid-discovery',time:new Date().toISOString()}));
app.get('/api/apps',async(req,res)=>{let list=await apps(); const q=String(req.query.q||'').toLowerCase(); const cat=String(req.query.category||'').toLowerCase(); if(q) list=list.filter(x=>(x.name+' '+x.description+' '+x.category).toLowerCase().includes(q)); if(cat&&cat!=='all') list=list.filter(x=>x.category.toLowerCase()===cat); res.json(list.sort((a,b)=>Number(b.featured)-Number(a.featured)||b.downloads-a.downloads));});
app.get('/api/announcements',async(req,res)=>res.json(await announcements()));
app.post('/api/admin/login',async(req,res)=>{const {username,password}=req.body||{}; if(username===(process.env.ADMIN_USERNAME||'admin')&&password===(process.env.ADMIN_PASSWORD||'1234')) return res.json({token:sign(username)}); res.status(401).json({error:'Wrong username or password'});});
app.get('/api/admin/apps',auth,async(req,res)=>res.json(await apps()));

// Manual upload. This remains available when you want to add your own APKs.
app.post('/api/admin/apps',auth,upload.single('file'),async(req,res)=>{
  const body=req.body||{}; if(!body.name) return res.status(400).json({error:'App name is required'});
  const id=crypto.randomUUID(); let fileKey=''; let fileSize=0;
  if(req.file){fileSize=req.file.size; const key=`apps/${id}/${safeName(req.file.originalname)}`; fileKey=key;
    if(r2Enabled){const stream=fsSync.createReadStream(req.file.path); await s3.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:stream,ContentType:req.file.mimetype||'application/octet-stream',CacheControl:'public,max-age=31536000,immutable'})); await fs.unlink(req.file.path);}
    else {const localName=`${id}-${safeName(req.file.originalname)}`; await fs.rename(req.file.path,path.join(uploadDir,localName)); fileKey=localName;}
  }
  const item={id,name:body.name,slug:(body.slug||slugify(body.name)),description:body.description||'New app on FLAXXI Store',category:body.category||'Apps',version:body.version||'1.0.0',size:body.size||((fileSize/1024/1024).toFixed(1)+' MB'),rating:Number(body.rating||4.8),downloads:0,icon:body.icon||'',fileKey,featured:String(body.featured)==='true',createdAt:new Date().toISOString(),source:'admin-upload'};
  const list=await apps(); list.push(item); await writeJson('apps.json',list);
  const news=await announcements(); news.unshift({id:crypto.randomUUID(),title:`New app: ${item.name}`,message:`${item.name} is now available on FLAXXI Store.`,appId:id,createdAt:new Date().toISOString()}); await writeJson('announcements.json',news.slice(0,30));
  res.json(item);
});

// FLAXXI Bot: discover open-source/authorized Android releases from F-Droid.
// It never scrapes random APK sites. Candidates are shown to the admin before import.
app.get('/api/admin/bot/candidates',auth,async(req,res)=>res.json(await botCandidates()));
app.post('/api/admin/bot/discover',auth,async(req,res)=>{
  try{
    const limit=Math.min(Math.max(Number(req.body?.limit||12),1),30);
    const response=await fetch(F_DROID_INDEX,{headers:{'user-agent':'FLAXXI-Store-Bot/1.0'}});
    if(!response.ok) throw new Error(`F-Droid index returned ${response.status}`);
    const index=await response.json();
    const existing=await apps(); const known=new Set(existing.map(x=>x.packageName).filter(Boolean));
    const old=await botCandidates(); const knownCandidates=new Set(old.map(x=>x.packageName));
    const entries=Object.entries(index.packages||{}).map(([packageName,p])=>({packageName,p}));
    entries.sort((a,b)=>Number(b.p?.metadata?.added||0)-Number(a.p?.metadata?.added||0));
    const found=[];
    for(const {packageName,p} of entries){
      if(found.length>=limit) break; if(known.has(packageName)||knownCandidates.has(packageName)) continue;
      const versions=Array.isArray(p.versions)?p.versions:[]; if(!versions.length) continue;
      const latest=versions[0]; if(!latest?.apkName) continue;
      const metadata=p.metadata||{}; const title=metadata.name||metadata.summary||packageName;
      found.push({id:crypto.randomUUID(),source:'F-Droid',packageName,name:title,description:metadata.description||metadata.summary||'Open-source Android app',summary:metadata.summary||'',version:latest.versionName||String(latest.versionCode||'latest'),versionCode:latest.versionCode||'',apkName:latest.apkName,apkUrl:F_DROID_BASE+latest.apkName,icon:metadata.icon?F_DROID_BASE+metadata.icon:'',category:categoryFrom(metadata.categories||metadata.category||[]),license:metadata.license||'Unknown',homepage:metadata.webSite||metadata.sourceCode||'',size:latest.size||0,status:'waiting_approval',discoveredAt:new Date().toISOString()});
    }
    const merged=[...found,...old].slice(0,100); await writeJson('bot_candidates.json',merged);
    res.json({ok:true,found:found.length,candidates:merged});
  }catch(e){res.status(502).json({error:`Bot discovery failed: ${e.message}`})}
});

async function saveRemoteApk(item,id){
  const response=await fetch(item.apkUrl,{redirect:'follow',headers:{'user-agent':'FLAXXI-Store-Bot/1.0'}});
  if(!response.ok||!response.body) throw new Error(`APK download failed (${response.status})`);
  const temp=path.join(uploadDir,`bot-${id}.apk`);
  await pipeline(Readable.fromWeb(response.body),fsSync.createWriteStream(temp));
  const stat=await fs.stat(temp); const key=`apps/${id}/${safeName(item.apkName||item.name+'.apk')}`;
  if(r2Enabled){await s3.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:fsSync.createReadStream(temp),ContentType:'application/vnd.android.package-archive',CacheControl:'public,max-age=31536000,immutable'})); await fs.unlink(temp); return {key,size:stat.size};}
  const localName=`${id}-${safeName(item.apkName||item.name+'.apk')}`; await fs.rename(temp,path.join(uploadDir,localName)); return {key:localName,size:stat.size};
}

app.post('/api/admin/bot/import/:id',auth,async(req,res)=>{
  try{
    const candidates=await botCandidates(); const candidate=candidates.find(x=>x.id===req.params.id); if(!candidate)return res.status(404).json({error:'Candidate not found'});
    if(candidate.status==='imported') return res.status(409).json({error:'Already imported'});
    const existing=await apps(); if(existing.some(x=>x.packageName===candidate.packageName)) return res.status(409).json({error:'App already exists in store'});
    const id=crypto.randomUUID(); const file=await saveRemoteApk(candidate,id);
    const item={id,name:candidate.name,slug:slugify(candidate.name),description:candidate.description,category:candidate.category||'Apps',version:candidate.version||'latest',size:((file.size/1024/1024).toFixed(1)+' MB'),rating:4.8,downloads:0,icon:candidate.icon||'',fileKey:file.key,featured:false,createdAt:new Date().toISOString(),source:'FLAXXI Bot / F-Droid',packageName:candidate.packageName,homepage:candidate.homepage,license:candidate.license};
    existing.push(item); await writeJson('apps.json',existing);
    const news=await announcements(); news.unshift({id:crypto.randomUUID(),title:`🤖 New app found by FLAXXI Bot: ${item.name}`,message:`${item.name} ${item.version} has been added to FLAXXI Store.`,appId:id,createdAt:new Date().toISOString()}); await writeJson('announcements.json',news.slice(0,30));
    await writeJson('bot_candidates.json',candidates.map(x=>x.id===candidate.id?{...x,status:'imported',importedAppId:id,importedAt:new Date().toISOString()}:x));
    res.json({ok:true,item});
  }catch(e){res.status(502).json({error:`Bot import failed: ${e.message}`})}
});

app.delete('/api/admin/bot/candidates/:id',auth,async(req,res)=>{const list=await botCandidates(); await writeJson('bot_candidates.json',list.filter(x=>x.id!==req.params.id)); res.json({ok:true});});

app.delete('/api/admin/apps/:id',auth,async(req,res)=>{const list=await apps(); const item=list.find(x=>x.id===req.params.id); if(!item)return res.status(404).json({error:'Not found'}); if(r2Enabled&&item.fileKey) await s3.send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET,Key:item.fileKey})); await writeJson('apps.json',list.filter(x=>x.id!==item.id)); res.json({ok:true});});
app.patch('/api/admin/apps/:id',auth,async(req,res)=>{const list=await apps(); const i=list.findIndex(x=>x.id===req.params.id); if(i<0)return res.status(404).json({error:'Not found'}); list[i]={...list[i],...req.body,id:list[i].id}; await writeJson('apps.json',list); res.json(list[i]);});

app.get('/api/download/:id',async(req,res)=>{const list=await apps(); const item=list.find(x=>x.id===req.params.id); if(!item||!item.fileKey)return res.status(404).send('App file not available yet.'); item.downloads=(item.downloads||0)+1; await writeJson('apps.json',list);
  const cdn=(process.env.CDN_BASE_URL||process.env.R2_PUBLIC_BASE_URL||'').replace(/\/$/,'');
  if(cdn) return res.redirect(302,`${cdn}/${item.fileKey}`);
  if(r2Enabled){const obj=await s3.send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:item.fileKey})); res.setHeader('Content-Type',obj.ContentType||'application/octet-stream'); res.setHeader('Content-Disposition',`attachment; filename="${safeName(item.name)}.apk"`); if(obj.ContentLength)res.setHeader('Content-Length',obj.ContentLength); obj.Body.pipe(res); return;}
  res.download(path.join(uploadDir,item.fileKey),`${safeName(item.name)}.apk`);
});
app.use('/admin',express.static(path.join(__dirname,'admin'))); app.use(express.static(path.join(__dirname,'public'))); app.get('/admin/*splat',(req,res)=>res.sendFile(path.join(__dirname,'admin/index.html'))); app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
app.listen(PORT,()=>console.log(`FLAXXI Store running on ${PORT}`));
