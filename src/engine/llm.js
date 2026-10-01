import { engineEnv } from './config.js';

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

// A slow response is never aborted by us: the request is already being billed,
// so cutting it off and resending only pays twice. The client timeout below is
// a safety net for a dead connection (15 min), not a speed limit. Retries are
// reserved for errors where the router itself gave up (5xx/429/network) and are
// few and spaced out, so a struggling upstream is not hammered.
const RETRY_DELAYS_MS = [10_000, 30_000];

export function isTransient(err) {
  return err instanceof LlmError && (!err.status || [408, 425, 429, 500, 502, 503, 504].includes(err.status));
}

// chat() with bounded retries for router hiccups (5xx / timeouts / 429). The
// router's upstream occasionally times out under load; one slow call should
// not cost an article.
export async function chat(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await chatOnce(opts);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

// OpenAI-compatible chat completion against the Eter router. glm-5.3-flash is
// a reasoning model, so reasoning tokens count against max_tokens — callers
// must leave headroom or the visible answer comes back empty.
async function chatOnce({ messages, maxTokens = 9000, temperature = 0.3, json = true, timeoutMs = 900_000, model }) {
  const env = engineEnv();
  if (!env.llmKey) throw new LlmError('LLM_API_KEY is not set', 401);
  const body = {
    model: model || env.llmModel,
    messages,
    max_tokens: maxTokens,
    temperature
  };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.llmKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch { /* handled below */ }
    if (!res.ok) {
      const detail = payload?.error?.message || payload?.error || raw.slice(0, 200);
      throw new LlmError(`LLM ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status);
    }
    const choice = payload?.choices?.[0];
    const text = choice?.message?.content ?? '';
    return {
      text,
      finishReason: choice?.finish_reason || null,
      usage: {
        promptTokens: payload?.usage?.prompt_tokens || 0,
        completionTokens: payload?.usage?.completion_tokens || 0,
        reasoningTokens: payload?.usage?.completion_tokens_details?.reasoning_tokens || 0
      },
      latencyMs: Date.now() - started,
      model: payload?.model || body.model
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
    // Network-level failures (DNS, reset, TLS) surface as TypeError("fetch failed"); treat as transient.
    if (!(err instanceof LlmError)) throw new LlmError(`LLM request failed: ${err.cause?.code || err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Pulls the first balanced top-level JSON object out of model text, tolerating
// code fences or a stray preamble.
export function parseJsonObject(text) {
  const src = String(text || '').trim();
  if (!src) throw new LlmError('Model returned empty text');
  try { return JSON.parse(src); } catch { /* fall through to scan */ }
  const start = src.indexOf('{');
  if (start === -1) throw new LlmError('No JSON object in model output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch (err) {
          throw new LlmError(`Model JSON did not parse: ${err.message}`);
        }
      }
    }
  }
  throw new LlmError('Model JSON was truncated (unbalanced braces)');
}

export async function pingLlm() {
  const started = Date.now();
  const out = await chat({
    messages: [{ role: 'user', content: 'Reply with the JSON {"ok":true}.' }],
    maxTokens: 2000,
    timeoutMs: 60_000
  });
  const parsed = parseJsonObject(out.text);
  return { ok: parsed?.ok === true, latencyMs: Date.now() - started, model: out.model };
}
