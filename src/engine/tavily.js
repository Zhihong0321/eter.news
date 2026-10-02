import { engineEnv } from './config.js';
import { maskSecret } from './secrets.js';

export class TavilyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TavilyError';
    this.status = status;
  }
}

// ---- key pool ---------------------------------------------------------------
// Requests rotate round-robin across every configured key. A key that comes back
// rejected, rate limited or out of credits is benched for a while and the
// request moves on to the next key, so one exhausted key never stalls a run.
const HOUR = 3_600_000;
const COOLDOWN_MS = { 401: 6 * HOUR, 402: HOUR, 429: 60_000, 432: HOUR, 433: HOUR };
const benched = new Map(); // key -> { until, status, message }
let cursor = 0;

export function resetTavilyPool() {
  benched.clear();
  cursor = 0;
}

// Counts only - never the keys themselves.
export function tavilyPoolStatus() {
  const { tavilyKeys } = engineEnv();
  const now = Date.now();
  const cooling = tavilyKeys.filter((k) => (benched.get(k)?.until ?? 0) > now).length;
  return { keys: tavilyKeys.length, cooling };
}

function nextKeys(keys) {
  const start = cursor % keys.length;
  cursor = (start + 1) % keys.length;
  const now = Date.now();
  return keys.map((_, i) => keys[(start + i) % keys.length]).filter((k) => (benched.get(k)?.until ?? 0) <= now);
}

async function request(key, path, body, timeoutMs) {
  const env = engineEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.tavilyUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const detail = json?.detail?.error || json?.detail || json?.error || text.slice(0, 200);
      throw new TavilyError(`Tavily ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new TavilyError(`Tavily request timed out after ${timeoutMs}ms`);
    if (!(err instanceof TavilyError)) throw new TavilyError(`Tavily request failed: ${err.cause?.code || err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body, { timeoutMs = 120_000, key = null } = {}) {
  const { tavilyKeys } = engineEnv();
  if (!tavilyKeys.length) throw new TavilyError('TAVILY_API_KEY is not set');
  if (key) return request(key, path, body, timeoutMs);

  const candidates = nextKeys(tavilyKeys);
  if (!candidates.length) {
    const soonest = tavilyKeys.map((k) => benched.get(k)).sort((a, b) => a.until - b.until)[0];
    throw new TavilyError(`All ${tavilyKeys.length} Tavily key(s) are unavailable - ${soonest.message}`, soonest.status);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await request(candidate, path, body, timeoutMs);
    } catch (err) {
      if (!COOLDOWN_MS[err.status]) throw err;
      benched.set(candidate, { until: Date.now() + COOLDOWN_MS[err.status], status: err.status, message: err.message });
      console.warn(`[engine] Tavily key ${maskSecret(candidate)} benched for ${Math.round(COOLDOWN_MS[err.status] / 60_000)} min: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}

// News search with full-page markdown included, so one call yields both the
// candidate list and the article text the writer needs.
export async function searchNews({ query, days = 2, maxResults = 5 }) {
  const json = await post('/search', {
    query,
    topic: 'news',
    days,
    max_results: maxResults,
    search_depth: 'basic',
    include_raw_content: 'markdown',
    include_answer: false,
    include_images: false
  });
  const results = (json?.results || []).map((r) => ({
    url: r.url,
    title: r.title || '',
    snippet: r.content || '',
    rawContent: r.raw_content || '',
    publishedAt: r.published_date || null,
    score: typeof r.score === 'number' ? r.score : 0
  }));
  return { results, responseTime: json?.response_time ?? null, requestId: json?.request_id ?? null };
}

// Fallback for results whose search payload had no usable page text.
export async function extractUrl(url) {
  const json = await post('/extract', { urls: [url], format: 'markdown', extract_depth: 'basic' }, { timeoutMs: 120_000 });
  const hit = json?.results?.[0];
  return hit?.raw_content || '';
}

// Tests each key on its own (1 credit per key) so a bad key in the pool is named.
export async function pingTavily() {
  const { tavilyKeys } = engineEnv();
  if (!tavilyKeys.length) throw new TavilyError('TAVILY_API_KEY is not set');
  const keys = [];
  for (const key of tavilyKeys) {
    const started = Date.now();
    try {
      await post('/search', { query: 'news', topic: 'news', days: 1, max_results: 1 }, { key });
      keys.push({ key: maskSecret(key), ok: true, latencyMs: Date.now() - started });
    } catch (err) {
      keys.push({ key: maskSecret(key), ok: false, error: err.message });
    }
  }
  const bad = keys.filter((k) => !k.ok);
  return {
    ok: bad.length === 0,
    latencyMs: Math.max(...keys.map((k) => k.latencyMs || 0)),
    keys,
    error: bad.length ? `${bad.length} of ${keys.length} key(s) failed: ${bad.map((k) => `${k.key} ${k.error}`).join('; ')}` : undefined
  };
}
