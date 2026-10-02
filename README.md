# Eter News — Public News Portal (`eter.my`)

The public-facing bilingual news portal for **Eter News**, powered by PostgreSQL and Node.js.

## Features
- **Public News Portal**: Front page (`/`) with region grouping, bilingual English/Chinese news, search, country & tag filters, and dark mode.
- **Reader Archive**: Date-based edition reader (`/read`).
- **Built-in news engine**: Tavily finds fresh news → `glm-5.3-flash` (via the Eter router) writes a bilingual infographic packet → published straight to PostgreSQL. Runs on a schedule inside the same service.
- **Gather Monitor** (`/admin`): live run status, per-stage funnel, per-article results, event log, token/credit usage, topic and schedule controls, connection tests.

## News engine

```
engine_topics ──► Tavily /search (news, page text) ──► dedupe (URL + title)
              ──► glm-5.3-flash writer (JSON, 1 repair retry) ──► validate
              ──► articles + article_enrichments (what the portal reads)
```

- Code: `src/engine/` (`tavily.js`, `llm.js`, `generate.js`, `pipeline.js`, `scheduler.js`, `store.js`, `admin.js`).
- Tables created automatically on boot (`CREATE IF NOT EXISTS`): `engine_topics`, `engine_runs`, `engine_items`, `engine_events`, `engine_settings`. Existing `articles` / `article_enrichments` are reused untouched.
- Topics are seeded as region × section (30 queries) and editable in `/admin`. Each run searches the least-recently-searched topics first.
- Cost controls (all editable in `/admin` → Settings): topics per run, results per topic, max articles per run, interval.
- Sources that are thin, not news, or filtered by the model are marked *rejected*, not failed.

## Gather Monitor & API keys

Only `DATABASE_URL` is required. Everything else lives in PostgreSQL:

1. Deploy. The server log prints `ADMIN SETUP REQUIRED … setup code: XXXXX-XXXXX`.
2. Open `/admin`, enter the setup code, choose an admin password and paste the Tavily + LLM keys. They are stored in Postgres (keys AES-256-GCM encrypted, password scrypt-hashed).
3. From then on `/admin/keys` edits/tests/removes the keys and changes the admin password. Changes apply immediately, no redeploy.

Optional env: `SECRETS_KEY` (encryption key; defaults to one derived from `DATABASE_URL`), `HUB_API_KEY` (extra admin password / `x-hub-key` header), `TAVILY_API_KEY` (one key, or several separated by commas - requests rotate round-robin and a rate-limited or out-of-credit key is benched for a while) / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` (fallbacks when nothing is stored; "Import from environment" copies them into the database).

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
