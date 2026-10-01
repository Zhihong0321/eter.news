import { engineEnv } from './config.js';

export class TavilyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TavilyError';
    this.status = status;
  }
}

async function post(path, body, { timeoutMs = 45_000 } = {}) {
  const env = engineEnv();
  if (!env.tavilyKey) throw new TavilyError('TAVILY_API_KEY is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.tavilyUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.tavilyKey}` },
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
  const json = await post('/extract', { urls: [url], format: 'markdown', extract_depth: 'basic' }, { timeoutMs: 60_000 });
  const hit = json?.results?.[0];
  return hit?.raw_content || '';
}

export async function pingTavily() {
  const started = Date.now();
  const { results } = await searchNews({ query: 'news', days: 1, maxResults: 1 });
  return { ok: true, latencyMs: Date.now() - started, results: results.length };
}
