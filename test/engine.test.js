import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import * as store from '../src/engine/store.js';
import { normalizePacket, generatePacket, RejectedArticle } from '../src/engine/generate.js';
import { startRun, setPipelineDeps, engineStatus, normalizeUrl } from '../src/engine/pipeline.js';
import { parseJsonObject } from '../src/engine/llm.js';
import { renderInfographicDocument } from '../templates/infographic/render.js';
import { PUBLISHED_ARTICLES_SQL } from '../src/db.js';
import { engineEnv, setCredentialOverrides } from '../src/engine/config.js';
import { searchNews, pingTavily, resetTavilyPool, tavilyPoolStatus } from '../src/engine/tavily.js';
import { handleAdminApi, announceAdminSetup } from '../src/engine/admin.js';
import { pipelineHealth } from '../src/engine/health.js';

process.env.TAVILY_API_KEY = 'test-tavily';
process.env.LLM_API_KEY = 'test-llm';

const pair = (en, zh) => ({ en, zh });

function rawPacket(overrides = {}) {
  return {
    relevant: true,
    country: 'my',
    section: 'energy',
    tags: ['Solar', 'PPA'],
    publisher: 'The Star',
    displayTitle: pair('SD Guthrie JV signs 21-year solar deal', 'SD Guthrie合资企业签署21年太阳能协议'),
    summary: pair('A joint venture signed a 21-year renewable deal for data centres.', '一家合资企业为数据中心签署了21年可再生能源协议。'),
    keyFacts: [
      { text: pair('Term is 21 years', '期限为21年') },
      { text: pair('Capacity is 100 MW', '容量为100兆瓦') },
      { text: pair('Offtaker is a data centre operator', '购电方为数据中心运营商') }
    ],
    centralInsight: pair('Data centres are locking in long-term clean power.', '数据中心正在锁定长期清洁电力。'),
    keyTakeaway: pair('Long PPAs are becoming the norm.', '长期购电协议正成为常态。'),
    dimensions: [{
      title: pair('Scale', '规模'),
      insight: pair('The deal is large for the region.', '该协议在区域内规模较大。'),
      relationship: 'comparison',
      suggestedPresentation: 'number',
      metrics: [{ label: pair('Capacity', '容量'), value: '100', unit: pair('MW', '兆瓦') }],
      supportingFacts: [{ text: pair('Signed this week', '本周签署') }]
    }],
    timeline: [{ date: '2026-09-29', event: pair('Deal announced', '协议公布') }, { date: 'soon', event: pair('bad', '坏') }],
    whatToWatch: [pair('Regulatory approval', '监管批准')],
    uncertainties: [pair('Final tariff undisclosed', '最终电价未披露')],
    ...overrides
  };
}

const candidate = {
  url: 'https://example.com/a',
  title: 'SD Guthrie JV signs deal',
  publishedAt: 'Tue, 29 Sep 2026 13:35:00 GMT'
};

test('normalizePacket accepts a good packet and cleans it', () => {
  const { packet, meta } = normalizePacket(rawPacket(), candidate, { country: '', section: 'business' });
  assert.equal(meta.country, 'MY');
  assert.equal(meta.section, 'energy');
  assert.deepEqual(meta.tags, ['solar', 'ppa']);
  assert.equal(packet.dimensions[0].metrics[0].value, 100, 'string metric coerced to number');
  assert.equal(packet.timeline.length, 1, 'undated timeline entry dropped');
  assert.equal(packet.sources[0].url, candidate.url);
  assert.equal(packet.dimensions[0].supportingFacts[0].sourceId, 's1');
  assert.equal(packet.coreNews.publishedAt, '2026-09-29T13:35:00.000Z');
});

test('normalizePacket reports problems and honours relevant:false', () => {
  const bad = normalizePacket(rawPacket({ displayTitle: pair('Only English', '') , keyFacts: [] }), candidate, null);
  assert.ok(bad.problems.some((p) => p.includes('displayTitle')));
  assert.ok(bad.problems.some((p) => p.includes('keyFacts')));
  assert.throws(() => normalizePacket({ relevant: false, reason: 'cookie wall' }, candidate, null), RejectedArticle);
});

test('a metric-less dimension cannot claim a numeric presentation', () => {
  const raw = rawPacket();
  raw.dimensions[0].metrics = [];
  const { packet } = normalizePacket(raw, candidate, null);
  assert.equal(packet.dimensions[0].suggestedPresentation, 'text');
});

test('normalized packet renders through the existing infographic template', () => {
  const { packet, meta } = normalizePacket(rawPacket(), candidate, null);
  const html = renderInfographicDocument(
    { infographicContent: packet, coreNews: { country: meta.country, source: meta.publisher, published_at: meta.publishedAt, url: candidate.url } },
    { defaultLang: 'en', colorway: 'masela', animations: true }
  );
  assert.match(html, /SD Guthrie JV signs 21-year solar deal/);
  assert.match(html, /兆瓦/);
});

test('parseJsonObject tolerates fences and preamble, rejects truncation', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
  assert.throws(() => parseJsonObject('{"a": [1,2'), /truncated/);
});

test('normalizeUrl strips tracking params and rejects non-http', () => {
  assert.equal(normalizeUrl('https://x.com/a?utm_source=y&id=3#frag'), 'https://x.com/a?id=3');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});

test('generatePacket repairs invalid output with one retry (mocked router)', async () => {
  const realFetch = globalThis.fetch;
  const replies = [
    JSON.stringify(rawPacket({ keyFacts: [] })),
    JSON.stringify(rawPacket())
  ];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (calls === 1) {
      assert.ok(body.messages.at(-1).content.includes('Validation failed'), 'repair prompt carries the validation errors');
    }
    return new Response(JSON.stringify({
      model: 'sn-glm-5-3-flash',
      choices: [{ finish_reason: 'stop', message: { content: replies[calls++] } }],
      usage: { prompt_tokens: 100, completion_tokens: 200 }
    }), { status: 200 });
  };
  try {
    const usage = [];
    const out = await generatePacket(candidate, null, 'x'.repeat(2000), { onUsage: (u) => usage.push(u) });
    assert.equal(out.attempts, 2);
    assert.equal(usage.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('two empty completions are rejected (filtered), not failed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '' } }],
    usage: { prompt_tokens: 10, completion_tokens: 0 }
  }), { status: 200 });
  try {
    await assert.rejects(() => generatePacket(candidate, null, 'x'.repeat(500)), RejectedArticle);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Pipeline + store against a real Postgres engine (PGlite)
// ---------------------------------------------------------------------------
let currentPg = null;

async function freshDb() {
  const pg = new PGlite();
  currentPg = pg;
  store.setDb({
    query: (text, params) => pg.query(text, params),
    tx: (fn) => pg.transaction((t) => fn({ query: (text, params) => t.query(text, params) }))
  });
  await store.ensureEngineSchema();
  return pg;
}

async function waitIdle() {
  for (let i = 0; i < 200 && engineStatus().running; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(engineStatus().running, false, 'run should finish');
}

test('schema bootstraps, seeds topics, and clamps settings', async () => {
  await freshDb();
  const topics = await store.listTopics();
  assert.equal(topics.length, 30);
  const settings = await store.updateSettings({ intervalMinutes: 1, concurrency: 99, paused: true });
  assert.equal(settings.intervalMinutes, 5);
  assert.equal(settings.concurrency, 6);
  assert.equal(settings.paused, true);
  await assert.rejects(() => store.updateSettings({ nope: 1 }), /Unknown setting/);
  assert.equal((await store.schemaCheck()).ok, true);
});

test('full run: search → dedupe → write → publish, with rejects and failures tracked', async () => {
  await freshDb();
  await store.updateSettings({ topicsPerRun: 1, concurrency: 2, minSourceChars: 200 });
  const longText = 'Body text. '.repeat(100);
  const results = [
    { url: 'https://n.com/good?utm_source=tw', title: 'Good article', snippet: '', rawContent: longText, publishedAt: '2026-09-30T00:00:00Z', score: 0.9 },
    { url: 'https://n.com/good', title: 'Good article dup', snippet: '', rawContent: longText, publishedAt: null, score: 0.8 },
    { url: 'https://n.com/junk', title: 'Cookie wall', snippet: '', rawContent: longText, publishedAt: null, score: 0.7 },
    { url: 'https://n.com/boom', title: 'Explodes in writer', snippet: '', rawContent: longText, publishedAt: null, score: 0.6 },
    { url: 'https://n.com/thin', title: 'Thin page', snippet: '', rawContent: '', publishedAt: null, score: 0.5 }
  ];
  let searches = 0;
  setPipelineDeps({
    searchNews: async () => { searches += 1; return { results, responseTime: 0.5 }; },
    extractUrl: async () => 'too short',
    generatePacket: async (cand, topic, _text, { onUsage }) => {
      onUsage({ promptTokens: 10, completionTokens: 20 });
      if (cand.url.endsWith('/junk')) throw new RejectedArticle('cookie wall');
      if (cand.url.endsWith('/boom')) throw new Error('model exploded');
      const norm = normalizePacket(rawPacket({ displayTitle: pair(`Title for ${cand.title}`, `标题 ${cand.title}`) }), cand, topic);
      return { ...norm, attempts: 1 };
    }
  });

  const runId = await startRun('manual');
  await assert.rejects(() => startRun('manual'), /already in progress/);
  await waitIdle();

  const run = await store.getRun(runId);
  assert.equal(searches, 1);
  assert.equal(run.status, 'partial');
  assert.equal(run.topics_done, 1);
  assert.equal(run.found, 5);
  assert.equal(run.fresh, 4, 'tracking-param duplicate collapsed');
  assert.equal(run.published, 1);
  assert.equal(run.rejected, 2, 'junk (model reject) + thin source');
  assert.equal(run.failed, 1);
  assert.equal(run.tavily_calls, 2, '1 search + 1 extract fallback');
  assert.equal(run.llm_calls, 3);
  assert.equal(run.prompt_tokens, 30);

  const items = await store.getRunItems(runId);
  const byUrl = Object.fromEntries(items.map((i) => [i.url, i]));
  assert.equal(byUrl['https://n.com/good'].status, 'published');
  assert.equal(byUrl['https://n.com/boom'].status, 'failed');
  assert.match(byUrl['https://n.com/boom'].error, /model exploded/);
  assert.equal(byUrl['https://n.com/thin'].status, 'skipped');

  // Published row is exactly what the portal reads.
  const articles = await store.getRecentArticles();
  assert.equal(articles.length, 1);
  assert.equal(articles[0].status, 'enriched');
  assert.equal(articles[0].country, 'MY');

  // The portal's own read query must surface the article with the fields its filter requires.
  const portal = await currentPg.query(PUBLISHED_ARTICLES_SQL);
  assert.equal(portal.rows.length, 1);
  const shown = portal.rows[0].infographic_content.coreNews;
  assert.ok(shown.displayTitle.en && shown.displayTitle.zh && shown.summary.en && shown.summary.zh);
  assert.ok(Array.isArray(portal.rows[0].tags));

  // Re-running must not republish: the URL is now known.
  const second = await startRun('manual');
  await waitIdle();
  const run2 = await store.getRun(second);
  assert.equal(run2.published, 0);
  assert.equal(run2.fresh, 3, 'only previously failed/rejected urls are retried');
});

test('search auth failure aborts the run with a clear status', async () => {
  await freshDb();
  setPipelineDeps({
    searchNews: async () => { const e = new Error('Tavily 401: Unauthorized'); e.status = 401; throw e; }
  });
  const runId = await startRun('manual');
  await waitIdle();
  const run = await store.getRun(runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Unauthorized/);
});

test('persisting into a pre-existing enrichment table with extra required columns is flagged', async () => {
  const pg = new PGlite();
  store.setDb({
    query: (t, p) => pg.query(t, p),
    tx: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) }))
  });
  await pg.query(`create table article_enrichments (
    id serial primary key, article_id bigint not null, status text not null,
    infographic_content jsonb, enriched_at timestamptz, prompt_version text not null)`);
  await store.ensureEngineSchema();
  const check = await store.schemaCheck();
  assert.equal(check.ok, false);
  assert.deepEqual(check.blockers, ['prompt_version']);
});

test('credentials are stored encrypted, override env, mask on read, and can be cleared', async () => {
  process.env.SECRETS_KEY = 'unit-test-secret-1';
  process.env.TAVILY_API_KEY = 'env-tavily-key-1234';
  const pg = await freshDb();
  assert.equal(engineEnv().tavilyKey, 'env-tavily-key-1234');

  const status = await store.saveCredentials({ tavilyKey: 'tvly-db-secret-ABCDEFGH', llmModel: 'glm-5.3-flash' });
  const tav = status.find((c) => c.name === 'tavilyKey');
  assert.equal(tav.source, 'database');
  assert.ok(!JSON.stringify(status).includes('db-secret'), 'full secret never returned');
  assert.equal(engineEnv().tavilyKey, 'tvly-db-secret-ABCDEFGH');

  const raw = (await pg.query(`select value_enc from engine_credentials where name = 'tavilyKey'`)).rows[0].value_enc;
  assert.ok(raw.startsWith('v1:') && !raw.includes('db-secret'), 'ciphertext at rest');

  // A fresh process (cache cleared) reloads the key from Postgres.
  await store.loadCredentials();
  assert.equal(engineEnv().tavilyKey, 'tvly-db-secret-ABCDEFGH');

  await assert.rejects(() => store.saveCredentials({ llmBaseUrl: 'ftp://nope' }), /http/);
  await assert.rejects(() => store.saveCredentials({ tavilyKey: 'has space in it' }), /whitespace/);
  await assert.rejects(() => store.saveCredentials({ bogus: 'x'.repeat(12) }), /Unknown credential/);

  await store.clearCredential('tavilyKey');
  assert.equal(engineEnv().tavilyKey, 'env-tavily-key-1234', 'falls back to environment');

  // Rotating the encryption key makes stored values unreadable, and says so.
  await store.saveCredentials({ llmKey: 'sk-llm-secret-12345678' });
  process.env.SECRETS_KEY = 'rotated-secret';
  await store.loadCredentials();
  const after = await store.credentialStatus();
  assert.equal(after.find((c) => c.name === 'llmKey').storedUnreadable, true);
  process.env.SECRETS_KEY = 'unit-test-secret-1';
});

// ---------------------------------------------------------------------------
// Admin auth with no environment variables: setup code → Postgres password
// ---------------------------------------------------------------------------
function call(method, route, { body, cookie } = {}) {
  const req = {
    method,
    headers: { host: 'eter.test', ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); }
  };
  return new Promise(async (resolve) => {
    const res = {};
    const sendJson = (_res, status, payload, headers = {}) => resolve({ status, payload, headers });
    const url = new URL(`http://eter.test/api/admin/${route}`);
    await handleAdminApi(req, res, url.pathname, url, { sendJson, readJsonBody: async (r) => { let s = ''; for await (const c of r) s += c; return s ? JSON.parse(s) : {}; } });
  });
}

test('first-run setup stores the admin password and API keys in Postgres, no env vars', async () => {
  delete process.env.HUB_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.DATABASE_URL = 'postgres://u:p@h/db';
  delete process.env.SECRETS_KEY;
  const pg = await freshDb();
  store.setDb({ query: (t, p) => pg.query(t, p), tx: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })) });

  // Boot log prints the code; capture it.
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  await announceAdminSetup();
  console.log = realLog;
  const code = logs.join(' ').match(/code: ([A-F0-9]{5}-[A-F0-9]{5})/)[1];

  assert.deepEqual((await call('GET', 'status')).payload, { ok: true, configured: false });
  assert.equal((await call('POST', 'login', { body: { password: 'whatever12345' } })).status, 409);
  assert.equal((await call('GET', 'state')).status, 401, 'dashboard locked before setup');

  const bad = await call('POST', 'setup', { body: { code: 'AAAAA-BBBBB', password: 'a-long-password-1' } });
  assert.equal(bad.status, 401);
  const short = await call('POST', 'setup', { body: { code, password: 'short' } });
  assert.equal(short.status, 500);

  const ok = await call('POST', 'setup', { body: { code, password: 'a-long-password-1', credentials: { tavilyKey: 'tvly-setup-key-12345', llmKey: 'sk-setup-key-123456', llmModel: 'glm-5.3-flash' } } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'].split(';')[0];

  const state = await call('GET', 'state', { cookie });
  assert.equal(state.status, 200);
  assert.equal(state.payload.config.tavilyConfigured, true);
  assert.deepEqual(state.payload.config.missing, []);

  const stored = (await pg.query('select name, value_enc from engine_credentials order by name')).rows;
  assert.deepEqual(stored.map((r) => r.name), ['llmKey', 'llmModel', 'tavilyKey']);
  assert.ok(stored.every((r) => !r.value_enc.includes('setup-key')), 'encrypted at rest');
  const adminRow = (await pg.query('select pw_hash from engine_admin')).rows[0];
  assert.ok(adminRow.pw_hash && !adminRow.pw_hash.includes('long-password'));

  // Setup is one-shot; login works with the new password only.
  assert.equal((await call('POST', 'setup', { body: { code, password: 'another-password-9' } })).status, 409);
  assert.equal((await call('POST', 'login', { body: { password: 'wrong-password-1' } })).status, 401);
  assert.equal((await call('POST', 'login', { body: { password: 'a-long-password-1' } })).status, 200);

  // Password change ends old sessions and the new password works.
  const changed = await call('POST', 'password', { cookie, body: { current: 'a-long-password-1', next: 'brand-new-password-2' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', 'state', { cookie })).status, 401, 'old session invalidated');
  assert.equal((await call('POST', 'login', { body: { password: 'brand-new-password-2' } })).status, 200);
  delete process.env.DATABASE_URL;
});

test('publishes into the production-shaped enrichment table (url/provider/validation/provenance)', async () => {
  const pg = new PGlite();
  store.setDb({
    query: (t, p) => pg.query(t, p),
    tx: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) }))
  });
  await pg.query(`create table article_enrichments (
    id bigserial primary key, article_id bigint not null unique, url text not null, status text not null,
    provider text, model text, infographic_content jsonb, validation jsonb not null default '{}'::jsonb,
    provenance jsonb, error text, enriched_at timestamptz, updated_at timestamptz default now())`);
  await store.ensureEngineSchema();
  assert.equal((await store.schemaCheck()).ok, true);

  const { packet, meta } = normalizePacket(rawPacket(), candidate, null);
  const args = { candidate, topic: { query: 'q' }, packet, meta, bodyText: 'body', model: 'glm-5.3-flash', attempts: 2 };
  const id = await store.persistPublishedArticle(args);
  await store.persistPublishedArticle(args); // idempotent re-publish
  const rows = (await pg.query('select * from article_enrichments')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].article_id, id);
  assert.equal(rows[0].url, candidate.url);
  assert.equal(rows[0].status, 'enriched');
  assert.equal(rows[0].provider, 'eter-router');
  assert.equal(rows[0].validation.attempts, 2);
  assert.equal(rows[0].provenance.searchEngine, 'tavily');
  const portal = await pg.query(PUBLISHED_ARTICLES_SQL);
  assert.equal(portal.rows.length, 1);
});

test('network-level fetch failures are retried like router 5xx', async () => {
  const { chat } = await import('../src/engine/llm.js');
  process.env.LLM_API_KEY = 'test-llm';
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, ms > 1000 ? 1 : ms, ...a); // skip backoff waits
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: {} }), { status: 200 });
  };
  try {
    const out = await chat({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 5000 });
    assert.equal(out.text, '{"ok":true}');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
  }
});

test('a slow/unavailable model is retried within the run, not failed', async () => {
  const { LlmError } = await import('../src/engine/llm.js');
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.LLM_API_KEY = 'test-llm';
  await freshDb();
  await store.updateSettings({ topicsPerRun: 1, concurrency: 2, minSourceChars: 200 });
  const text = 'Body text. '.repeat(100);
  const results = ['a', 'b', 'c'].map((k, i) => ({ url: `https://n.com/${k}`, title: `Story ${k}`, snippet: '', rawContent: text, publishedAt: null, score: 1 - i / 10 }));
  const attempts = {};
  setPipelineDeps({
    retryDelayMs: 5,
    searchNews: async () => ({ results, responseTime: 0.1 }),
    extractUrl: async () => '',
    generatePacket: async (cand, topic) => {
      attempts[cand.url] = (attempts[cand.url] || 0) + 1;
      if (cand.url.endsWith('/a') && attempts[cand.url] < 2) throw new LlmError('LLM 503: TimeoutError', 503);
      return { ...normalizePacket(rawPacket({ displayTitle: pair(`T ${cand.title}`, `标题 ${cand.title}`) }), cand, topic), attempts: 1 };
    }
  });
  const runId = await startRun('manual');
  await waitIdle();
  const run = await store.getRun(runId);
  assert.equal(run.status, 'done');
  assert.equal(run.published, 3);
  assert.equal(run.failed, 0);
  assert.equal(attempts['https://n.com/a'], 2, 'one slow attempt, then success on the retry pass');
});

test('a model that never recovers is failed only after the retry passes', async () => {
  const { LlmError } = await import('../src/engine/llm.js');
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.LLM_API_KEY = 'test-llm';
  await freshDb();
  await store.updateSettings({ topicsPerRun: 1, concurrency: 1, minSourceChars: 200 });
  const text = 'Body text. '.repeat(100);
  let calls = 0;
  setPipelineDeps({
    retryDelayMs: 5,
    searchNews: async () => ({ results: [{ url: 'https://n.com/z', title: 'Z', snippet: '', rawContent: text, publishedAt: null, score: 1 }], responseTime: 0 }),
    extractUrl: async () => '',
    generatePacket: async () => { calls += 1; throw new LlmError('LLM 503: TimeoutError', 503); }
  });
  const runId = await startRun('manual');
  await waitIdle();
  const run = await store.getRun(runId);
  assert.equal(calls, 2, 'two passes, not a retry storm');
  assert.equal(run.failed, 1);
  assert.equal(run.status, 'failed');
});

test('cost guards: a failing model trips the breaker and the run stops spending', async () => {
  const { LlmError } = await import('../src/engine/llm.js');
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.LLM_API_KEY = 'test-llm';
  await freshDb();
  await store.updateSettings({ topicsPerRun: 1, concurrency: 1, minSourceChars: 200, failureBreaker: 2 });
  const text = 'Body text. '.repeat(100);
  const results = Array.from({ length: 6 }, (_, i) => ({ url: `https://n.com/${i}`, title: `S${i}`, snippet: '', rawContent: text, publishedAt: null, score: 1 - i / 10 }));
  let calls = 0;
  setPipelineDeps({
    retryDelayMs: 5,
    searchNews: async () => ({ results, responseTime: 0 }),
    extractUrl: async () => '',
    generatePacket: async () => { calls += 1; throw new LlmError('LLM 503: TimeoutError', 503); }
  });
  const runId = await startRun('manual');
  await waitIdle();
  const run = await store.getRun(runId);
  assert.equal(calls, 2, 'stopped after 2 consecutive model errors instead of trying all 6');
  assert.equal(run.status, 'stopped');
});

test('cost guards: token budget stops new articles', async () => {
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.LLM_API_KEY = 'test-llm';
  await freshDb();
  await store.updateSettings({ topicsPerRun: 1, concurrency: 1, minSourceChars: 200, maxTokensPerRun: 20000 });
  const text = 'Body text. '.repeat(100);
  const results = Array.from({ length: 5 }, (_, i) => ({ url: `https://n.com/${i}`, title: `S${i}`, snippet: '', rawContent: text, publishedAt: null, score: 1 - i / 10 }));
  setPipelineDeps({
    searchNews: async () => ({ results, responseTime: 0 }),
    extractUrl: async () => '',
    generatePacket: async (cand, topic, _t, { onUsage }) => {
      onUsage({ promptTokens: 10000, completionTokens: 5000 });
      return { ...normalizePacket(rawPacket({ displayTitle: pair(`T ${cand.title}`, `title ${cand.title}`) }), cand, topic), attempts: 1 };
    }
  });
  const runId = await startRun('manual');
  await waitIdle();
  const run = await store.getRun(runId);
  assert.ok(run.published >= 1 && run.published < 5, `published ${run.published} of 5 before budget hit`);
  assert.equal(run.status, 'stopped');
});

test('wrapped packets are unwrapped, and failures name the keys actually returned', () => {
  const wrapped = normalizePacket({ relevant: true, result: rawPacket() }, candidate, null);
  assert.ok(wrapped.packet, 'unwrapped one level');
  const bad = normalizePacket({ relevant: true, notes: 'hello', title: 'x' }, candidate, null);
  assert.ok(bad.problems.at(-1).includes('relevant, notes, title'));
});

test('pipelineHealth: flags an idle engine, then tracks overdue, stale, failed and paused states', async () => {
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.LLM_API_KEY = 'test-llm';
  await freshDb();
  const empty = await pipelineHealth();
  assert.equal(empty.healthy, false);
  assert.equal(empty.state, 'scheduled');
  assert.ok(empty.problems.some((p) => /no published articles/.test(p)));

  await store.updateSettings({ topicsPerRun: 1, concurrency: 1, minSourceChars: 200 });
  const text = 'Body text. '.repeat(100);
  setPipelineDeps({
    searchNews: async () => ({ results: [{ url: 'https://n.com/h', title: 'Health story', snippet: '', rawContent: text, publishedAt: null, score: 1 }], responseTime: 0 }),
    extractUrl: async () => '',
    generatePacket: async (cand, topic) => ({ ...normalizePacket(rawPacket(), cand, topic), attempts: 1 })
  });
  const runId = await startRun('manual');
  await waitIdle();

  const ok = await pipelineHealth();
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.healthy, true);
  assert.equal(ok.publishedLast24h, 1);
  assert.equal(ok.lastRun.status, 'done');
  assert.equal(ok.lastRun.published, 1);
  assert.ok(ok.lastSuccessAt && ok.lastPublishedAt && ok.schedule.nextRunAt);

  const overdue = await pipelineHealth(Date.now() + 2 * 3_600_000);
  assert.ok(overdue.problems.some((p) => /has not started/.test(p)), 'run 2h past its due time is flagged');

  await currentPg.query(`update article_enrichments set enriched_at = now() - interval '10 hours'`);
  const stale = await pipelineHealth();
  assert.ok(stale.problems.some((p) => /no new article for 10h/.test(p)));

  await currentPg.query(`update engine_runs set status = 'failed' where id = $1`, [runId]);
  const failed = await pipelineHealth();
  assert.ok(failed.problems.some((p) => p.includes(`last run #${runId} failed`)));

  await store.updateSettings({ paused: true });
  const paused = await pipelineHealth();
  assert.equal(paused.state, 'paused');
  assert.ok(paused.problems.some((p) => /paused/.test(p)));
});

// ---------------------------------------------------------------------------
// Tavily key pool (fake keys, mocked fetch)
// ---------------------------------------------------------------------------
async function withTavilyFetch(keys, handler, fn) {
  const realFetch = globalThis.fetch;
  const used = [];
  setCredentialOverrides({});
  process.env.TAVILY_API_KEY = keys.join(',');
  resetTavilyPool();
  globalThis.fetch = async (_url, init) => {
    const key = init.headers.authorization.replace('Bearer ', '');
    used.push(key);
    const { status = 200, body = { results: [] } } = handler(key, used.length) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    await fn(used);
  } finally {
    globalThis.fetch = realFetch;
    process.env.TAVILY_API_KEY = 'test-tavily';
    resetTavilyPool();
  }
}

test('tavily pool: requests rotate round-robin across every key', async () => {
  const keys = ['tvly-test-key-aaaa1111', 'tvly-test-key-bbbb2222', 'tvly-test-key-cccc3333'];
  await withTavilyFetch(keys, () => ({}), async (used) => {
    for (let i = 0; i < 6; i += 1) await searchNews({ query: 'q' });
    assert.deepEqual(used, [...keys, ...keys]);
    assert.deepEqual(tavilyPoolStatus(), { keys: 3, cooling: 0 });
  });
});

test('tavily pool: an exhausted or rate-limited key is benched and the request moves on', async () => {
  const [a, b, c] = ['tvly-test-key-aaaa1111', 'tvly-test-key-bbbb2222', 'tvly-test-key-cccc3333'];
  await withTavilyFetch([a, b, c], (key) => (key === b ? { status: 432, body: { detail: { error: 'usage limit' } } } : {}), async (used) => {
    await searchNews({ query: 'q' });
    await searchNews({ query: 'q' }); // starts on b: 432, falls through to c
    assert.deepEqual(used, [a, b, c]);
    assert.deepEqual(tavilyPoolStatus(), { keys: 3, cooling: 1 });
    used.length = 0;
    for (let i = 0; i < 4; i += 1) await searchNews({ query: 'q' });
    assert.ok(!used.includes(b), 'benched key is skipped');
    assert.ok(used.includes(a) && used.includes(c));
  });

  await withTavilyFetch([a, b], () => ({ status: 432, body: { detail: { error: 'usage limit' } } }), async () => {
    await assert.rejects(() => searchNews({ query: 'q' }), (err) => err.status === 432);
    assert.deepEqual(tavilyPoolStatus(), { keys: 2, cooling: 2 });
    await assert.rejects(() => searchNews({ query: 'q' }), /All 2 Tavily key\(s\) are unavailable/);
  });

  // A bad request is the caller's fault: it must not bench anyone.
  await withTavilyFetch([a, b], () => ({ status: 400, body: { detail: { error: 'bad query' } } }), async (used) => {
    await assert.rejects(() => searchNews({ query: 'q' }), (err) => err.status === 400);
    assert.equal(used.length, 1);
    assert.equal(tavilyPoolStatus().cooling, 0);
  });
});

test('tavily pool: pingTavily names the bad key; adding keys merges, dedupes and masks', async () => {
  const [a, b] = ['tvly-test-key-aaaa1111', 'tvly-test-key-bbbb2222'];
  await withTavilyFetch([a, b], (key) => (key === b ? { status: 401, body: { detail: { error: 'Unauthorized' } } } : {}), async () => {
    const out = await pingTavily();
    assert.equal(out.ok, false);
    assert.equal(out.keys.length, 2);
    assert.match(out.error, /1 of 2 key\(s\) failed/);
    assert.ok(!out.error.includes(b), 'full key never reported');
  });

  process.env.SECRETS_KEY = 'unit-test-secret-1';
  setCredentialOverrides({});
  process.env.TAVILY_API_KEY = a;
  await freshDb();
  const status = await store.addTavilyKeys(`${a}, ${b}\ntvly-test-key-cccc3333`);
  const tav = status.find((c) => c.name === 'tavilyKey');
  assert.equal(tav.keyCount, 3, 'env key + new keys, duplicate dropped');
  assert.ok(!JSON.stringify(status).includes('bbbb2222'), 'full keys never returned');
  assert.equal(engineEnv().tavilyKeys.length, 3);
  await assert.rejects(() => store.addTavilyKeys('  ,  '), /cannot be empty/);
  await assert.rejects(() => store.saveCredentials({ tavilyKey: `${a},short` }), /too short/);
  setCredentialOverrides({});
  process.env.TAVILY_API_KEY = 'test-tavily';
});
