import { query as poolQuery, getPool, isDbEnabled } from '../db.js';
import { SETTING_DEFAULTS, SETTING_LIMITS, CREDENTIALS, buildSeedTopics, setCredentialOverrides, credentialSource, engineEnv } from './config.js';
import { encrypt, decrypt, maskSecret, canEncrypt } from './secrets.js';

// ---------------------------------------------------------------------------
// DB access seam. Production uses the shared pg pool; tests inject an
// in-memory Postgres (PGlite) through setDb().
// ---------------------------------------------------------------------------
let injected = null;

export function setDb(db) {
  injected = db;
  schemaReady = null;
  enrichmentColsCache = null;
}

function q(text, params) {
  return injected ? injected.query(text, params) : poolQuery(text, params);
}

async function tx(fn) {
  if (injected?.tx) return injected.tx(fn);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn({ query: (t, p) => client.query(t, p) });
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function engineDbEnabled() {
  return Boolean(injected) || isDbEnabled();
}

// ---------------------------------------------------------------------------
// Schema. Base portal tables are CREATE IF NOT EXISTS so a fresh database
// works, while an existing production schema is left untouched.
// ---------------------------------------------------------------------------
const SCHEMA_SQL = [
  `create table if not exists articles (
     id            bigserial primary key,
     source        text,
     country       text,
     title         text not null,
     url           text not null unique,
     published_at  timestamptz,
     author        text,
     section       text,
     body          text,
     description   text,
     fetched_at    timestamptz,
     tags          text[],
     dedup_title   text,
     created_at    timestamptz default now(),
     updated_at    timestamptz default now()
   )`,
  `create table if not exists article_enrichments (
     id                   bigserial primary key,
     article_id           bigint not null,
     status               text,
     infographic_content  jsonb,
     enriched_at          timestamptz,
     created_at           timestamptz default now(),
     updated_at           timestamptz default now()
   )`,
  `create table if not exists article_pipeline_status (
     article_id     bigint not null,
     stage          text not null,
     status         text not null,
     attempts       integer default 0,
     last_error     text,
     next_retry_at  timestamptz,
     updated_at     timestamptz default now(),
     primary key (article_id, stage)
   )`,
  `create table if not exists engine_settings (
     key         text primary key,
     value       jsonb not null,
     updated_at  timestamptz default now()
   )`,
  `create table if not exists engine_topics (
     id           serial primary key,
     query        text not null unique,
     region       text not null default 'World',
     country      text not null default '',
     section      text not null default 'business',
     enabled      boolean not null default true,
     last_run_at  timestamptz,
     last_found   integer,
     last_new     integer
   )`,
  `create table if not exists engine_runs (
     id                 serial primary key,
     trigger            text not null,
     status             text not null default 'running',
     started_at         timestamptz not null default now(),
     finished_at        timestamptz,
     topics_total       integer not null default 0,
     topics_done        integer not null default 0,
     found              integer not null default 0,
     fresh              integer not null default 0,
     generated          integer not null default 0,
     published          integer not null default 0,
     rejected           integer not null default 0,
     failed             integer not null default 0,
     tavily_calls       integer not null default 0,
     llm_calls          integer not null default 0,
     prompt_tokens      integer not null default 0,
     completion_tokens  integer not null default 0,
     error              text
   )`,
  `create table if not exists engine_items (
     id           bigserial primary key,
     run_id       integer not null references engine_runs(id) on delete cascade,
     url          text not null,
     title        text,
     topic_id     integer,
     stage        text not null,
     status       text not null,
     article_id   bigint,
     error        text,
     attempts     integer not null default 0,
     tokens       integer not null default 0,
     latency_ms   integer,
     updated_at   timestamptz not null default now(),
     unique (run_id, url)
   )`,
  `create table if not exists engine_events (
     id      bigserial primary key,
     run_id  integer references engine_runs(id) on delete cascade,
     at      timestamptz not null default now(),
     level   text not null default 'info',
     stage   text not null,
     message text not null,
     meta    jsonb
   )`,
  `create table if not exists engine_credentials (
     name        text primary key,
     value_enc   text not null,
     updated_at  timestamptz not null default now()
   )`,
  `create index if not exists engine_events_run_idx on engine_events (run_id, id)`,
  `create index if not exists engine_items_run_idx on engine_items (run_id)`
];

let schemaReady = null;

export function ensureEngineSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA_SQL) await q(sql);
      await seedTopicsIfEmpty();
      await loadCredentials();
      // A process that died mid-run leaves a 'running' row behind.
      await q(`update engine_runs set status = 'interrupted', finished_at = now(),
                      error = coalesce(error, 'process restarted during run')
                where status = 'running'`);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function seedTopicsIfEmpty() {
  const { rows } = await q('select count(*)::int as n from engine_topics');
  if (rows[0].n > 0) return;
  for (const t of buildSeedTopics()) {
    await q(
      `insert into engine_topics (query, region, country, section) values ($1, $2, $3, $4)
       on conflict (query) do nothing`,
      [t.query, t.region, t.country, t.section]
    );
  }
}

// ---------------------------------------------------------------------------
// Credentials (API keys) — encrypted at rest in engine_credentials
// ---------------------------------------------------------------------------
const unreadable = new Set();

export async function loadCredentials() {
  const { rows } = await q('select name, value_enc from engine_credentials');
  const values = {};
  unreadable.clear();
  for (const row of rows) {
    if (!(row.name in CREDENTIALS)) continue;
    const plain = canEncrypt() ? decrypt(row.value_enc) : null;
    if (plain) values[row.name] = plain;
    else unreadable.add(row.name);
  }
  setCredentialOverrides(values);
}

function validateCredential(name, raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${CREDENTIALS[name].label} cannot be empty`);
  if (/\s/.test(value)) throw new Error(`${CREDENTIALS[name].label} must not contain whitespace`);
  if (value.length > 600) throw new Error(`${CREDENTIALS[name].label} is too long`);
  if (name === 'llmBaseUrl') {
    let u;
    try { u = new URL(value); } catch { throw new Error('LLM base URL must be a valid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('LLM base URL must start with http:// or https://');
  }
  if (CREDENTIALS[name].secret && value.length < 8) throw new Error(`${CREDENTIALS[name].label} looks too short`);
  return value;
}

// patch: { name: newValue }. Names absent from the patch are untouched.
export async function saveCredentials(patch) {
  await ensureEngineSchema();
  const entries = Object.entries(patch || {}).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  for (const [name] of entries) {
    if (!(name in CREDENTIALS)) throw new Error(`Unknown credential "${name}"`);
  }
  if (entries.length && !canEncrypt()) {
    throw new Error('Set SECRETS_KEY (or HUB_API_KEY) on the server first — credentials are stored encrypted');
  }
  const cleaned = entries.map(([name, raw]) => [name, validateCredential(name, raw)]);
  for (const [name, value] of cleaned) {
    await q(
      `insert into engine_credentials (name, value_enc, updated_at) values ($1, $2, now())
       on conflict (name) do update set value_enc = excluded.value_enc, updated_at = now()`,
      [name, encrypt(value)]
    );
  }
  await loadCredentials();
  return credentialStatus();
}

export async function clearCredential(name) {
  await ensureEngineSchema();
  if (!(name in CREDENTIALS)) throw new Error(`Unknown credential "${name}"`);
  await q('delete from engine_credentials where name = $1', [name]);
  await loadCredentials();
  return credentialStatus();
}

// Never returns a full secret: secrets are masked, non-secrets shown as-is.
export async function credentialStatus() {
  await ensureEngineSchema();
  const { rows } = await q('select name, updated_at from engine_credentials');
  const updated = Object.fromEntries(rows.map((r) => [r.name, r.updated_at]));
  const env = engineEnv();
  return Object.entries(CREDENTIALS).map(([name, def]) => {
    const effective = env[name] || '';
    return {
      name,
      label: def.label,
      secret: def.secret,
      source: unreadable.has(name) && credentialSource(name) !== 'database' ? `${credentialSource(name)} (stored value unreadable)` : credentialSource(name),
      storedUnreadable: unreadable.has(name),
      value: def.secret ? maskSecret(effective) : effective,
      set: Boolean(effective),
      updatedAt: updated[name] || null
    };
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function coerceSetting(key, value) {
  if (!(key in SETTING_DEFAULTS)) throw new Error(`Unknown setting "${key}"`);
  if (typeof SETTING_DEFAULTS[key] === 'boolean') return Boolean(value);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Setting "${key}" must be a number`);
  const [min, max] = SETTING_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function getSettings() {
  await ensureEngineSchema();
  const { rows } = await q('select key, value from engine_settings');
  const out = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key in out) {
      try { out[row.key] = coerceSetting(row.key, row.value); } catch { /* keep default */ }
    }
  }
  return out;
}

export async function updateSettings(patch) {
  await ensureEngineSchema();
  for (const [key, raw] of Object.entries(patch || {})) {
    const value = coerceSetting(key, raw);
    await q(
      `insert into engine_settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  return getSettings();
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------
export async function listTopics() {
  await ensureEngineSchema();
  const { rows } = await q('select * from engine_topics order by region, section, id');
  return rows;
}

export async function pickTopicsForRun(limit) {
  await ensureEngineSchema();
  const { rows } = await q(
    `select * from engine_topics where enabled
      order by last_run_at asc nulls first, id
      limit $1`,
    [limit]
  );
  return rows;
}

export async function upsertTopic({ id, query: text, region, country, section, enabled }) {
  await ensureEngineSchema();
  const cleanQuery = String(text || '').trim();
  if (!cleanQuery || cleanQuery.length > 300) throw new Error('Topic query must be 1-300 characters');
  const cleanCountry = /^[A-Za-z]{2}$/.test(String(country || '')) ? String(country).toUpperCase() : '';
  const fields = [cleanQuery, String(region || 'World').slice(0, 60), cleanCountry, String(section || 'business').slice(0, 40), enabled !== false];
  if (id) {
    const { rows } = await q(
      `update engine_topics set query = $1, region = $2, country = $3, section = $4, enabled = $5
        where id = $6 returning *`,
      [...fields, id]
    );
    if (!rows.length) throw new Error('Topic not found');
    return rows[0];
  }
  const { rows } = await q(
    `insert into engine_topics (query, region, country, section, enabled) values ($1, $2, $3, $4, $5)
     on conflict (query) do update set region = excluded.region, country = excluded.country,
       section = excluded.section, enabled = excluded.enabled
     returning *`,
    fields
  );
  return rows[0];
}

export async function setTopicEnabled(id, enabled) {
  await ensureEngineSchema();
  await q('update engine_topics set enabled = $2 where id = $1', [id, Boolean(enabled)]);
}

export async function deleteTopic(id) {
  await ensureEngineSchema();
  await q('delete from engine_topics where id = $1', [id]);
}

export async function markTopicRan(id, found, fresh) {
  await q('update engine_topics set last_run_at = now(), last_found = $2, last_new = $3 where id = $1', [id, found, fresh]);
}

// ---------------------------------------------------------------------------
// Runs, items, events
// ---------------------------------------------------------------------------
const RUN_COUNTERS = new Set([
  'topics_total', 'topics_done', 'found', 'fresh', 'generated', 'published',
  'rejected', 'failed', 'tavily_calls', 'llm_calls', 'prompt_tokens', 'completion_tokens'
]);

export async function createRun(trigger) {
  await ensureEngineSchema();
  const { rows } = await q(`insert into engine_runs (trigger) values ($1) returning id`, [trigger]);
  await pruneOld();
  return rows[0].id;
}

// Atomic increments (relative, never read-modify-write) so concurrent workers
// can't lose updates.
export async function bumpRun(runId, deltas) {
  const sets = [];
  const params = [runId];
  for (const [key, delta] of Object.entries(deltas)) {
    if (!RUN_COUNTERS.has(key) || !delta) continue;
    params.push(delta);
    sets.push(`${key} = ${key} + $${params.length}`);
  }
  if (!sets.length) return;
  await q(`update engine_runs set ${sets.join(', ')} where id = $1`, params);
}

export async function setRunTotals(runId, topicsTotal) {
  await q('update engine_runs set topics_total = $2 where id = $1', [runId, topicsTotal]);
}

export async function finishRun(runId, status, error = null) {
  await q(
    `update engine_runs set status = $2, finished_at = now(), error = $3 where id = $1`,
    [runId, status, error ? String(error).slice(0, 500) : null]
  );
}

export async function logEvent(runId, level, stage, message, meta = null) {
  try {
    await q(
      `insert into engine_events (run_id, level, stage, message, meta) values ($1, $2, $3, $4, $5::jsonb)`,
      [runId, level, stage, String(message).slice(0, 600), meta ? JSON.stringify(meta) : null]
    );
  } catch (err) {
    // Logging must never take down a run.
    console.error('[engine] failed to write event:', err.message);
  }
}

export async function upsertItem(runId, url, patch) {
  const { title = null, topicId = null, stage, status, articleId = null, error = null, attempts = 0, tokens = 0, latencyMs = null } = patch;
  await q(
    `insert into engine_items (run_id, url, title, topic_id, stage, status, article_id, error, attempts, tokens, latency_ms, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     on conflict (run_id, url) do update set
       title = coalesce(excluded.title, engine_items.title),
       stage = excluded.stage,
       status = excluded.status,
       article_id = coalesce(excluded.article_id, engine_items.article_id),
       error = excluded.error,
       attempts = greatest(engine_items.attempts, excluded.attempts),
       tokens = engine_items.tokens + excluded.tokens,
       latency_ms = coalesce(excluded.latency_ms, engine_items.latency_ms),
       updated_at = now()`,
    [runId, url, title, topicId, stage, status, articleId, error ? String(error).slice(0, 500) : null, attempts, tokens, latencyMs]
  );
}

async function pruneOld() {
  await q(`delete from engine_runs where started_at < now() - interval '60 days'`);
  await q(`delete from engine_events where at < now() - interval '14 days'`);
}

export async function listRuns(limit = 30) {
  await ensureEngineSchema();
  const { rows } = await q('select * from engine_runs order by id desc limit $1', [limit]);
  return rows;
}

export async function getRun(runId) {
  await ensureEngineSchema();
  const { rows } = await q('select * from engine_runs where id = $1', [runId]);
  return rows[0] || null;
}

export async function getRunItems(runId) {
  const { rows } = await q('select * from engine_items where run_id = $1 order by id', [runId]);
  return rows;
}

export async function getEvents({ runId = null, afterId = 0, limit = 200 }) {
  await ensureEngineSchema();
  const { rows } = runId
    ? await q('select * from engine_events where run_id = $1 and id > $2 order by id desc limit $3', [runId, afterId, limit])
    : await q('select * from engine_events where id > $1 order by id desc limit $2', [afterId, limit]);
  return rows.reverse();
}

export async function getOverview() {
  await ensureEngineSchema();
  const { rows: [today] } = await q(`
    select count(*)::int as runs,
           coalesce(sum(published), 0)::int as published,
           coalesce(sum(failed), 0)::int as failed,
           coalesce(sum(rejected), 0)::int as rejected,
           coalesce(sum(tavily_calls), 0)::int as tavily_calls,
           coalesce(sum(llm_calls), 0)::int as llm_calls,
           coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
           coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
      from engine_runs where started_at > now() - interval '24 hours'`);
  const { rows: [totals] } = await q(`
    select count(*)::int as articles,
           count(*) filter (where e.status = 'enriched')::int as published
      from articles a left join article_enrichments e on e.article_id = a.id`);
  const { rows: [last] } = await q(`select max(finished_at) as at from engine_runs where status in ('done', 'partial')`);
  return { last24h: today, totals, lastSuccessAt: last?.at || null };
}

export async function getFailedItems(limit = 40) {
  await ensureEngineSchema();
  const { rows } = await q(
    `select i.*, r.started_at as run_started_at from engine_items i
       join engine_runs r on r.id = i.run_id
      where i.status = 'failed' order by i.updated_at desc limit $1`,
    [limit]
  );
  return rows;
}

export async function getRecentArticles(limit = 40) {
  await ensureEngineSchema();
  const { rows } = await q(
    `select a.id, a.title, a.url, a.source, a.country, a.section, a.fetched_at, e.status, e.enriched_at
       from articles a left join article_enrichments e on e.article_id = a.id
      order by a.id desc limit $1`,
    [limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Article persistence
// ---------------------------------------------------------------------------
export async function existingUrls(urls) {
  if (!urls.length) return new Set();
  const { rows } = await q('select url from articles where url = any($1::text[])', [urls]);
  return new Set(rows.map((r) => r.url));
}

export async function recentTitleKeys(days = 4) {
  const { rows } = await q(
    `select coalesce(dedup_title, title) as t from articles
      where fetched_at > now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return new Set(rows.map((r) => titleKey(r.t)));
}

export function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim().slice(0, 90);
}

let enrichmentColsCache = null;

async function enrichmentColumns() {
  if (!enrichmentColsCache) {
    const { rows } = await q(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'article_enrichments' and table_schema = current_schema()`
    );
    enrichmentColsCache = new Map(rows.map((r) => [r.column_name, r]));
  }
  return enrichmentColsCache;
}

// Columns this writer knows how to fill. Anything else that is NOT NULL with
// no default would make the insert fail, so schemaCheck() reports it up front.
const KNOWN_ENRICHMENT_COLUMNS = new Set([
  'id', 'article_id', 'status', 'infographic_content', 'enriched_at', 'created_at', 'updated_at', 'model', 'provider', 'error', 'last_error', 'attempts'
]);

export async function schemaCheck() {
  await ensureEngineSchema();
  const cols = await enrichmentColumns();
  const blockers = [];
  for (const [name, col] of cols) {
    if (col.is_nullable === 'NO' && !col.column_default && !KNOWN_ENRICHMENT_COLUMNS.has(name)) blockers.push(name);
  }
  return { ok: blockers.length === 0, columns: [...cols.keys()], blockers };
}

export async function persistPublishedArticle({ candidate, topic, packet, meta, bodyText, model }) {
  await ensureEngineSchema();
  const cols = await enrichmentColumns();
  const blockers = (await schemaCheck()).blockers;
  if (blockers.length) throw new Error(`article_enrichments has required columns the engine cannot fill: ${blockers.join(', ')}`);

  return tx(async (db) => {
    const { rows: [art] } = await db.query(
      `insert into articles
         (source, country, title, url, published_at, author, section, body, description, fetched_at, tags, dedup_title, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, $7, $8, now(), $9, $10, now())
       on conflict (url) do update set
         source = excluded.source, country = excluded.country, title = excluded.title,
         published_at = excluded.published_at, section = excluded.section, body = excluded.body,
         description = excluded.description, fetched_at = excluded.fetched_at,
         tags = excluded.tags, dedup_title = excluded.dedup_title, updated_at = now()
       returning id`,
      [
        meta.publisher,
        meta.country || null,
        candidate.title || meta.title,
        candidate.url,
        meta.publishedAt,
        meta.section || topic?.section || null,
        bodyText.slice(0, 60_000),
        packet.coreNews.summary.en,
        meta.tags,
        meta.title
      ]
    );
    const articleId = art.id;
    const content = JSON.stringify(packet);
    const jsonCast = cols.get('infographic_content')?.data_type === 'jsonb' ? '::jsonb'
      : cols.get('infographic_content')?.data_type === 'json' ? '::json' : '';

    const sets = [`status = 'enriched'`, `infographic_content = $2${jsonCast}`, 'enriched_at = now()'];
    const params = [articleId, content];
    if (cols.has('updated_at')) sets.push('updated_at = now()');
    if (cols.has('model')) { params.push(model); sets.push(`model = $${params.length}`); }
    if (cols.has('error')) sets.push('error = null');
    if (cols.has('last_error')) sets.push('last_error = null');

    const upd = await db.query(`update article_enrichments set ${sets.join(', ')} where article_id = $1`, params);
    if (!upd.rowCount) {
      const names = ['article_id', 'status', 'infographic_content', 'enriched_at'];
      const placeholders = ['$1', `'enriched'`, `$2${jsonCast}`, 'now()'];
      const ins = [articleId, content];
      if (cols.has('model')) { ins.push(model); names.push('model'); placeholders.push(`$${ins.length}`); }
      if (cols.has('updated_at')) { names.push('updated_at'); placeholders.push('now()'); }
      await db.query(`insert into article_enrichments (${names.join(', ')}) values (${placeholders.join(', ')})`, ins);
    }

    await db.query(
      `insert into article_pipeline_status (article_id, stage, status, attempts, last_error, next_retry_at, updated_at)
       values ($1, 'enrich', 'done', 0, null, null, now())
       on conflict (article_id, stage) do update set status = 'done', attempts = 0, last_error = null, next_retry_at = null, updated_at = now()`,
      [articleId]
    );
    return articleId;
  });
}
