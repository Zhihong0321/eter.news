# Eter News — Public News Portal (`eter.my`)

The public-facing bilingual news portal for **Eter News**, powered by PostgreSQL and Node.js.

## Features
- **Public News Portal**: Front page (`/`) with region grouping, bilingual English/Chinese news, search, country & tag filters, and dark mode.
- **Reader Archive**: Date-based edition reader (`/read`).
- **Direct DB Integration**: Reads published news directly from PostgreSQL (`DATABASE_URL`).
- **Lean Footprint**: No crawlers, factory dashboards, or heavy browser automation dependencies.

---

## Deployment to GitHub & Railway

### 1. Push to GitHub (`Zhihong0321/eter.news`)

Run the following commands inside this deployment directory:

```bash
git init
git add .
git commit -m "feat: initial release of Eter News public portal"
git branch -M main
git remote add origin https://github.com/Zhihong0321/eter.news.git
git push -u origin main --force
```

---

### 2. Deploy to Railway

1. Log into your [Railway Dashboard](https://railway.com/).
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select `Zhihong0321/eter.news`.
4. Under **Variables**, set:
   - `DATABASE_URL` = Your Postgres / Supabase database connection string.
   - `PORT` = `5177` (or Railway's default `$PORT`).
5. Under **Settings** -> **Networking** -> **Custom Domain**:
   - Add `eter.my` (and optional `www.eter.my`).
   - Update your DNS provider with the CNAME record provided by Railway.

---

## Local Development

```bash
npm install
npm run dev
```

Visit `http://localhost:5177`.
