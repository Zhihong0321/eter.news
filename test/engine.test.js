import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import * as store from '../src/engine/store.js';
import { normalizePacket, generatePacket, RejectedArticle } from '../src/engine/generate.js';
import { startRun, setPipelineDeps, engineStatus, normalizeUrl } from '../src/engine/pipeline.js';
import { parseJsonObject } from '../src/engine/llm.js';
import { renderInfographicDocument } from '../templates/infographic/render.js';
import { PUBLISHED_ARTICLES_SQL } from '../src/db.js';
import { engineEnv } from '../src/engine/config.js';

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
  process.env.HUB_API_KEY = 'unit-test-admin-key';
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
  process.env.HUB_API_KEY = 'rotated-key';
  await store.loadCredentials();
  const after = await store.credentialStatus();
  assert.equal(after.find((c) => c.name === 'llmKey').storedUnreadable, true);
  process.env.HUB_API_KEY = 'unit-test-admin-key';
});
