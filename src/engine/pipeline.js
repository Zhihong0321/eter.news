import { engineEnv } from './config.js';
import * as tavily from './tavily.js';
import { generatePacket as realGenerate, RejectedArticle } from './generate.js';
import {
  getSettings, getRun, pickTopicsForRun, createRun, setRunTotals, bumpRun, finishRun, logEvent,
  upsertItem, markTopicRan, existingUrls, recentTitleKeys, titleKey, persistPublishedArticle
} from './store.js';

// Seams so tests can drive the whole pipeline without network access.
let deps = { searchNews: tavily.searchNews, extractUrl: tavily.extractUrl, generatePacket: realGenerate };

export function setPipelineDeps(overrides) {
  deps = { searchNews: tavily.searchNews, extractUrl: tavily.extractUrl, generatePacket: realGenerate, ...overrides };
}

let current = null;

export function engineStatus() {
  return current
    ? { running: true, runId: current.runId, trigger: current.trigger, startedAt: current.startedAt, stopRequested: current.stop }
    : { running: false };
}

export function requestStop() {
  if (!current) return false;
  current.stop = true;
  return true;
}

export function enginePrereqs() {
  const env = engineEnv();
  const missing = [];
  if (!env.tavilyKey) missing.push('TAVILY_API_KEY');
  if (!env.llmKey) missing.push('LLM_API_KEY');
  return missing;
}

const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|ref$|ref_)/i;

export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

// Starts a run in the background and returns its id immediately.
export async function startRun(trigger = 'manual') {
  if (current) throw new Error(`A run is already in progress (#${current.runId})`);
  const missing = enginePrereqs();
  if (missing.length) throw new Error(`Engine not configured: missing ${missing.join(', ')}`);

  const runId = await createRun(trigger);
  current = { runId, trigger, startedAt: new Date().toISOString(), stop: false };
  execute(runId, current).catch(async (err) => {
    console.error(`[engine] run #${runId} crashed:`, err.stack || err.message);
    await logEvent(runId, 'error', 'run', `Run crashed: ${err.message}`);
    await finishRun(runId, 'failed', err.message).catch(() => {});
  }).finally(() => {
    current = null;
  });
  return runId;
}

async function execute(runId, handle) {
  const settings = await getSettings();
  const topics = await pickTopicsForRun(settings.topicsPerRun);
  await setRunTotals(runId, topics.length);
  await logEvent(runId, 'info', 'run', `Run started (${handle.trigger}): ${topics.length} topics, up to ${settings.maxArticlesPerRun} articles`, {
    settings: { resultsPerTopic: settings.resultsPerTopic, searchDays: settings.searchDays, concurrency: settings.concurrency }
  });
  if (!topics.length) {
    await logEvent(runId, 'warn', 'run', 'No enabled topics — nothing to search');
    return finishRun(runId, 'done');
  }

  // ---- Stage 1: search -----------------------------------------------------
  const seenUrls = new Set();
  const candidates = [];
  let consecutiveSearchFailures = 0;
  let searchFatal = null;

  for (const topic of topics) {
    if (handle.stop) break;
    let results;
    try {
      const out = await deps.searchNews({ query: topic.query, days: settings.searchDays, maxResults: settings.resultsPerTopic });
      results = out.results;
      consecutiveSearchFailures = 0;
      await bumpRun(runId, { tavily_calls: 1, found: results.length, topics_done: 1 });
      await logEvent(runId, 'info', 'search', `"${topic.query}" → ${results.length} results`, { topicId: topic.id, ms: out.responseTime });
    } catch (err) {
      consecutiveSearchFailures += 1;
      await bumpRun(runId, { tavily_calls: 1, topics_done: 1 });
      await logEvent(runId, 'error', 'search', `"${topic.query}" failed: ${err.message}`, { topicId: topic.id });
      if (err.status === 401 || err.status === 402 || err.status === 432 || err.status === 433 || consecutiveSearchFailures >= 3) {
        searchFatal = err.message;
        break;
      }
      continue;
    }

    let fresh = 0;
    for (const r of results) {
      const url = normalizeUrl(r.url);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      candidates.push({ ...r, url, topic });
      fresh += 1;
    }
    await markTopicRan(topic.id, results.length, fresh);
  }

  if (searchFatal) {
    await logEvent(runId, 'error', 'run', `Aborting: search is failing (${searchFatal})`);
    return finishRun(runId, 'failed', `Tavily: ${searchFatal}`);
  }

  // ---- Stage 2: dedupe -----------------------------------------------------
  const known = await existingUrls(candidates.map((c) => c.url));
  const knownTitles = await recentTitleKeys();
  const batchTitles = new Set();
  let fresh = candidates.filter((c) => {
    if (known.has(c.url)) return false;
    const key = titleKey(c.title);
    if (key && (knownTitles.has(key) || batchTitles.has(key))) return false;
    if (key) batchTitles.add(key);
    return true;
  });
  const dupes = candidates.length - fresh.length;
  fresh.sort((a, b) => b.score - a.score);
  const overflow = Math.max(0, fresh.length - settings.maxArticlesPerRun);
  fresh = fresh.slice(0, settings.maxArticlesPerRun);
  await bumpRun(runId, { fresh: fresh.length });
  await logEvent(runId, 'info', 'dedupe', `${candidates.length} candidates → ${fresh.length} new (${dupes} already known${overflow ? `, ${overflow} deferred by per-run cap` : ''})`);

  // ---- Stage 3: write + publish -------------------------------------------
  const queue = [...fresh];
  const worker = async () => {
    while (queue.length && !handle.stop) {
      const item = queue.shift();
      await processCandidate(runId, item, settings);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, queue.length) }, worker));

  const rows = await getRun(runId);
  const status = handle.stop ? 'stopped'
    : rows.failed > 0 && rows.published === 0 ? 'failed'
    : rows.failed > 0 ? 'partial'
    : 'done';
  await logEvent(runId, rows.failed ? 'warn' : 'info', 'run',
    `Run ${status}: ${rows.published} published, ${rows.rejected} rejected, ${rows.failed} failed`);
  await finishRun(runId, status, status === 'failed' ? 'every article failed — see events' : null);
}

async function processCandidate(runId, c, settings) {
  const base = { title: c.title, topicId: c.topic.id };
  const started = Date.now();
  let tokens = 0;
  try {
    // Source text: Tavily's page content, or a single /extract fallback.
    let text = c.rawContent || '';
    if (text.length < settings.minSourceChars) {
      await upsertItem(runId, c.url, { ...base, stage: 'extract', status: 'running' });
      try {
        text = await deps.extractUrl(c.url);
        await bumpRun(runId, { tavily_calls: 1 });
      } catch (err) {
        await bumpRun(runId, { tavily_calls: 1 });
        text = '';
        await logEvent(runId, 'warn', 'extract', `extract failed for ${c.url}: ${err.message}`);
      }
    }
    if (text.length < settings.minSourceChars) {
      await bumpRun(runId, { rejected: 1 });
      await upsertItem(runId, c.url, { ...base, stage: 'extract', status: 'skipped', error: `source text too short (${text.length} chars)` });
      await logEvent(runId, 'info', 'extract', `skipped (thin source, ${text.length} chars): ${c.title}`);
      return;
    }

    await upsertItem(runId, c.url, { ...base, stage: 'write', status: 'running' });
    const out = await deps.generatePacket(c, c.topic, text, {
      onUsage: (usage) => {
        tokens += usage.promptTokens + usage.completionTokens;
        bumpRun(runId, { llm_calls: 1, prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens }).catch(() => {});
      }
    });
    await bumpRun(runId, { generated: 1 });

    await upsertItem(runId, c.url, { ...base, stage: 'publish', status: 'running', attempts: out.attempts, tokens });
    const articleId = await persistPublishedArticle({
      candidate: c, topic: c.topic, packet: out.packet, meta: out.meta, bodyText: text, model: engineEnv().llmModel, attempts: out.attempts
    });
    await bumpRun(runId, { published: 1 });
    await upsertItem(runId, c.url, { ...base, stage: 'publish', status: 'published', articleId, attempts: out.attempts, latencyMs: Date.now() - started });
    await logEvent(runId, 'info', 'publish', `#${articleId} ${out.meta.title}`, { url: c.url, country: out.meta.country, section: out.meta.section, tokens });
  } catch (err) {
    if (err instanceof RejectedArticle) {
      await bumpRun(runId, { rejected: 1 });
      await upsertItem(runId, c.url, { ...base, stage: 'write', status: 'rejected', error: err.message, tokens, latencyMs: Date.now() - started });
      await logEvent(runId, 'info', 'write', `rejected "${c.title}": ${err.message}`, { url: c.url });
      return;
    }
    await bumpRun(runId, { failed: 1 });
    await upsertItem(runId, c.url, { ...base, stage: 'write', status: 'failed', error: err.message, tokens, latencyMs: Date.now() - started });
    await logEvent(runId, 'error', 'write', `failed "${c.title}": ${err.message}`, { url: c.url });
  }
}
