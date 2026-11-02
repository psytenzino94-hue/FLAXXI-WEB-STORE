# FLAXXI Store — GitHub + Render + App Discovery Bot

Premium responsive FLAXXI Store UI with separate admin control center. Desktop follows the supplied wide reference; mobile switches to the single-column reference with bottom navigation.

## New: FLAXXI App Discovery Bot

The admin panel now has a **FLAXXI App Discovery Bot**. It searches the F-Droid open-source Android catalog for new releases, collects metadata and an authorized APK URL, and puts the result into a review queue.

Flow:

`Admin → 🤖 Find New Apps → Review candidate → Import → APK downloaded to R2/CDN → App published → FLAXXI announcement created`

The bot intentionally does **not** scrape random APK sites or re-upload copyrighted apps from unknown sources. You can add apps from sources you are authorized to redistribute.

## Manual uploads

Admin can still upload APK/XAPK/APKS/ZIP directly.

## Cloud downloads

For production, configure Cloudflare R2 and a CDN/custom domain. Render should handle the web/API layer while large APK files are stored and served from object storage/CDN. A literal 10x speed guarantee cannot be made by code alone; CDN location, network, file size, and user ISP all affect real speed.

## Render

Build command: `npm install`

Start command: `npm start`

Set the environment variables in `.env.example`. Do not commit `.env` or secrets.

## Admin

Open `/admin` on your deployed domain. Credentials are `ADMIN_USERNAME` and `ADMIN_PASSWORD` from Render environment variables.

## Bot API

- `POST /api/admin/bot/discover` — scan F-Droid and create candidates
- `GET /api/admin/bot/candidates` — review candidates
- `POST /api/admin/bot/import/:id` — download/import an approved candidate
- `DELETE /api/admin/bot/candidates/:id` — skip a candidate

All bot endpoints require the admin JWT.


### First login
If Render environment variables are not set yet, the development fallback is `admin` / `1234`. For a public deployment, set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a strong `JWT_SECRET` in Render and redeploy.
