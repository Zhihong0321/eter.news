import { chat, parseJsonObject } from './llm.js';

const RELATIONSHIPS = ['historical-context', 'comparison', 'cause', 'consequence', 'stakeholder-impact', 'contradiction', 'future-signal'];
const PRESENTATIONS = ['number', 'comparison', 'chart', 'timeline', 'map', 'quote', 'text'];
const SECTION_IDS = ['business', 'energy', 'technology', 'economy', 'policy', 'society', 'markets'];
const SOURCE_ID = 's1';
const MAX_SOURCE_CHARS = 9_000;

export class RejectedArticle extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RejectedArticle';
  }
}

const SYSTEM_PROMPT = `You are the editor of Eter News, a bilingual (English + Simplified Chinese) news desk covering Asia and the world.
You receive ONE source article. Produce an analytical infographic packet as a single JSON object.

HARD RULES
- Use ONLY facts present in the source text. Never invent numbers, names, quotes, dates or causes. If the source does not support a field, omit that item rather than guessing.
- Every human-readable string is a bilingual pair {"en": "...", "zh": "..."}. "zh" is natural Simplified Chinese, not a transliteration. Keep proper nouns recognisable (company names in English may stay in English inside the Chinese sentence).
- Neutral, factual register. No hype, no opinion presented as fact, no calls to action.
- If the source is NOT a news report (listicle, press-release boilerplate, paywall stub, login page, cookie wall, opinion with no news event, or under ~150 words of substance) return exactly {"relevant": false, "reason": "<short reason>"}.

OUTPUT SHAPE (all keys required unless marked optional)
{
  "relevant": true,
  "country": "ISO 3166-1 alpha-2 of the country the story is primarily about, e.g. MY, SG, CN, JP, KR, US, GB. Empty string if multinational.",
  "section": "one of: business | energy | technology | economy | policy | society | markets",
  "tags": ["3-6 short lowercase English tags"],
  "publisher": "name of the publication that wrote the source",
  "displayTitle": {"en": "<=90 chars, factual headline", "zh": "..."},
  "summary": {"en": "2-3 sentences, 40-80 words", "zh": "..."},
  "keyFacts": [{"text": {"en": "...", "zh": "..."}}],            // 3 to 6 verifiable facts
  "centralInsight": {"en": "one sentence: why this matters", "zh": "..."},
  "dimensions": [                                                  // 2 to 4 analytical angles
    {
      "title": {"en": "...", "zh": "..."},
      "insight": {"en": "1-2 sentences", "zh": "..."},
      "relationship": "one of: ${RELATIONSHIPS.join(' | ')}",
      "suggestedPresentation": "one of: ${PRESENTATIONS.join(' | ')}",
      "metrics": [                                                 // optional; only numbers stated in the source
        {"label": {"en":"","zh":""}, "value": 123.4, "unit": {"en":"MW","zh":"兆瓦"}, "period": {"en":"2025","zh":"2025年"}, "comparisonValue": 100, "comparisonPeriod": {"en":"2024","zh":"2024年"}}
      ],
      "supportingFacts": [{"text": {"en": "...", "zh": "..."}}]    // 1-3 items
    }
  ],
  "timeline": [{"date": "YYYY-MM-DD or YYYY-MM or YYYY", "event": {"en":"","zh":""}}],   // optional, only dated events in the source
  "keyTakeaway": {"en": "one sentence", "zh": "..."},
  "whatToWatch": [{"en":"","zh":""}],                              // 2-4 forward-looking items grounded in the source
  "uncertainties": [{"en":"","zh":""}]                             // 1-3 open questions or caveats
}
"value", "comparisonValue" are plain JSON numbers (no strings, no thousands separators, no units inside). Use presentation "number"/"comparison"/"chart" only when the dimension has at least one metric; otherwise "text", "timeline" or "quote".
Return the JSON object only.`;

function isPair(value) {
  return value && typeof value === 'object'
    && typeof value.en === 'string' && value.en.trim()
    && typeof value.zh === 'string' && value.zh.trim();
}

function cleanPair(value) {
  return { en: String(value.en).trim(), zh: String(value.zh).trim() };
}

function optPair(value) {
  return isPair(value) ? cleanPair(value) : undefined;
}

function cleanFacts(list, limit) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const text = isPair(item?.text) ? item.text : isPair(item) ? item : null;
    if (text) out.push({ text: cleanPair(text) });
    if (out.length >= limit) break;
  }
  return out;
}

function cleanPairList(list, limit) {
  if (!Array.isArray(list)) return [];
  return list.filter(isPair).slice(0, limit).map(cleanPair);
}

function cleanMetric(metric) {
  if (!metric || !isPair(metric.label)) return null;
  const value = typeof metric.value === 'number' ? metric.value : Number(String(metric.value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const out = { label: cleanPair(metric.label), value };
  const unit = optPair(metric.unit);
  const period = optPair(metric.period);
  const comparisonPeriod = optPair(metric.comparisonPeriod);
  if (unit) out.unit = unit;
  if (period) out.period = period;
  const cmp = typeof metric.comparisonValue === 'number' ? metric.comparisonValue : Number(metric.comparisonValue);
  if (Number.isFinite(cmp) && metric.comparisonValue !== null && metric.comparisonValue !== '') {
    out.comparisonValue = cmp;
    if (comparisonPeriod) out.comparisonPeriod = comparisonPeriod;
  }
  return out;
}

function cleanDimension(dim) {
  if (!dim || !isPair(dim.title) || !isPair(dim.insight)) return null;
  const metrics = (Array.isArray(dim.metrics) ? dim.metrics : []).map(cleanMetric).filter(Boolean).slice(0, 4);
  const supportingFacts = cleanFacts(dim.supportingFacts, 3).map((f) => ({ ...f, sourceId: SOURCE_ID }));
  let presentation = PRESENTATIONS.includes(dim.suggestedPresentation) ? dim.suggestedPresentation : 'text';
  if (['number', 'comparison', 'chart', 'map'].includes(presentation) && !metrics.length) presentation = 'text';
  if (presentation === 'quote' && !supportingFacts.length) presentation = 'text';
  return {
    title: cleanPair(dim.title),
    insight: cleanPair(dim.insight),
    relationship: RELATIONSHIPS.includes(dim.relationship) ? dim.relationship : 'cause',
    suggestedPresentation: presentation,
    metrics,
    supportingFacts
  };
}

function cleanTimeline(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.date === 'string' && /^\d{4}(-\d{2}){0,2}$/.test(e.date.trim()) && isPair(e.event))
    .slice(0, 6)
    .map((e) => ({ date: e.date.trim(), event: cleanPair(e.event) }));
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function publisherFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Validates + normalises model output into the shape stored in
// article_enrichments.infographic_content and consumed by render.js.
// Returns { problems } when the packet is unusable, otherwise { packet, meta }.
// Some completions wrap the packet ({"result": {...}}); unwrap one level.
function unwrapPacket(raw) {
  if (!raw || typeof raw !== 'object' || raw.displayTitle) return raw;
  for (const value of Object.values(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.displayTitle) return { ...value, relevant: value.relevant ?? raw.relevant };
  }
  return raw;
}

export function normalizePacket(rawInput, candidate, topic) {
  const problems = [];
  const raw = unwrapPacket(rawInput);
  if (!raw || typeof raw !== 'object') return { problems: ['output is not a JSON object'] };
  if (raw.relevant === false) throw new RejectedArticle(String(raw.reason || 'model judged source not a news report').slice(0, 200));

  const displayTitle = optPair(raw.displayTitle);
  const summary = optPair(raw.summary);
  const centralInsight = optPair(raw.centralInsight);
  const keyTakeaway = optPair(raw.keyTakeaway);
  const keyFacts = cleanFacts(raw.keyFacts, 6);
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).map(cleanDimension).filter(Boolean).slice(0, 4);

  if (!displayTitle) problems.push('displayTitle needs non-empty en and zh');
  if (!summary) problems.push('summary needs non-empty en and zh');
  if (!centralInsight) problems.push('centralInsight needs non-empty en and zh');
  if (!keyTakeaway) problems.push('keyTakeaway needs non-empty en and zh');
  if (keyFacts.length < 3) problems.push(`keyFacts needs at least 3 bilingual items (got ${keyFacts.length})`);
  if (dimensions.length < 1) problems.push('dimensions needs at least 1 valid item with title and insight pairs');
  if (displayTitle && displayTitle.en.length > 140) problems.push('displayTitle.en must be at most 90 characters');
  if (problems.length) {
    // Name what the model actually returned so the repair prompt and the dashboard show the real cause.
    problems.push(`top-level keys returned: ${Object.keys(raw).slice(0, 12).join(', ') || '(none)'}`);
    return { problems };
  }

  const publishedAt = toIso(candidate.publishedAt) || new Date().toISOString();
  const publisher = (typeof raw.publisher === 'string' && raw.publisher.trim()) || publisherFromUrl(candidate.url);
  const country = /^[A-Za-z]{2}$/.test(String(raw.country || '').trim())
    ? String(raw.country).trim().toUpperCase()
    : (topic?.country || '');
  const rawSection = String(raw.section || '').trim().toLowerCase();
  const section = SECTION_IDS.includes(rawSection) ? rawSection : (topic?.section || 'business');
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t && t.length <= 40)
    .slice(0, 6);

  const sources = [{
    id: SOURCE_ID,
    title: { en: candidate.title || displayTitle.en, zh: candidate.title || displayTitle.zh },
    publisher,
    url: candidate.url,
    publishedAt
  }];

  const packet = {
    coreNews: { displayTitle, summary, keyFacts, publisher, publishedAt, sourceUrl: candidate.url },
    centralInsight,
    dimensions,
    timeline: cleanTimeline(raw.timeline),
    keyTakeaway,
    whatToWatch: cleanPairList(raw.whatToWatch, 4),
    uncertainties: cleanPairList(raw.uncertainties, 3),
    sources
  };

  return {
    packet,
    meta: { country, section, tags, publisher, publishedAt, title: displayTitle.en }
  };
}

function buildUserPrompt(candidate, topic, text) {
  return [
    `Topic focus: ${topic?.region || 'World'} / ${topic?.section || 'general'}`,
    `Source URL: ${candidate.url}`,
    `Source title: ${candidate.title}`,
    `Source published: ${candidate.publishedAt || 'unknown'}`,
    '',
    '--- SOURCE TEXT ---',
    text,
    '--- END SOURCE TEXT ---'
  ].join('\n');
}

// One writer call, plus a single repair call that feeds back validation errors.
// onUsage(usage) lets the pipeline meter tokens per call.
export async function generatePacket(candidate, topic, sourceText, { onUsage } = {}) {
  const text = String(sourceText || '').slice(0, MAX_SOURCE_CHARS);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(candidate, topic, text) }
  ];

  let lastProblems = [];
  let emptyReplies = 0;
  let lastFinish = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const out = await chat({ messages, maxTokens: 8_000, temperature: attempt === 1 ? 0.3 : 0.1 });
    onUsage?.(out.usage, out.latencyMs);
    lastFinish = out.finishReason;
    if (!String(out.text || '').trim()) emptyReplies += 1;

    let parsed;
    try {
      parsed = parseJsonObject(out.text);
    } catch (err) {
      lastProblems = [err.message];
      if (out.finishReason === 'length') lastProblems.push('output hit the token limit; be more concise');
      messages.push({ role: 'assistant', content: out.text || '{}' });
      messages.push({ role: 'user', content: `Your previous output was unusable: ${lastProblems.join('; ')}. Return the corrected JSON object only.` });
      continue;
    }

    const result = normalizePacket(parsed, candidate, topic);
    if (result.packet) return { ...result, attempts: attempt };
    lastProblems = result.problems;
    messages.push({ role: 'assistant', content: out.text });
    messages.push({ role: 'user', content: `Validation failed: ${lastProblems.join('; ')}. Return the corrected full JSON object only.` });
  }
  // Two empty completions that did not hit the token cap is the router/model
  // declining to answer (e.g. a content filter) — a rejected source, not a fault.
  if (emptyReplies === 2 && lastFinish !== 'length') {
    throw new RejectedArticle(`model returned no content twice (finish_reason=${lastFinish || 'unknown'}), likely filtered`);
  }
  throw new Error(`Writer output failed validation after 2 attempts: ${lastProblems.join('; ')}`);
}
