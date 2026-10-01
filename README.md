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

## Gather Monitor

Open `/admin` and sign in with `HUB_API_KEY`. The same key works as an `x-hub-key` header on `/api/admin/*`.

## Environment

See `.env.example`: `DATABASE_URL`, `HUB_API_KEY`, `TAVILY_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `ENGINE_ENABLED`.

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
   - `HUB_API_KEY`, `TAVILY_API_KEY`, `LLM_API_KEY` (+ optional `LLM_BASE_URL`, `LLM_MODEL`) — see above.
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
