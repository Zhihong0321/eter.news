// Engine configuration. Credentials resolve database-first (managed from the
// /admin/keys page, stored encrypted in engine_credentials) and fall back to
// environment variables. Tunables an operator may change at runtime live in
// the engine_settings table (see store.js) and override the defaults below.

export const CREDENTIALS = {
  tavilyKey: { env: 'TAVILY_API_KEY', label: 'Tavily API key', secret: true },
  llmKey: { env: 'LLM_API_KEY', label: 'LLM router API key', secret: true },
  llmBaseUrl: { env: 'LLM_BASE_URL', label: 'LLM base URL', secret: false, fallback: 'https://e-router.up.railway.app/v1' },
  llmModel: { env: 'LLM_MODEL', label: 'LLM model', secret: false, fallback: 'glm-5.3-flash' }
};

// Values loaded from Postgres by store.loadCredentials(); read synchronously
// by engineEnv() so the hot paths never touch the database for a key.
let overrides = {};

export function setCredentialOverrides(values) {
  overrides = { ...values };
}

export function credentialSource(name) {
  const def = CREDENTIALS[name];
  if (overrides[name]) return 'database';
  if ((process.env[def.env] || '').trim()) return 'environment';
  return def.fallback ? 'default' : 'unset';
}

function resolve(name) {
  const def = CREDENTIALS[name];
  return String(overrides[name] || process.env[def.env] || def.fallback || '').trim();
}

export function engineEnv() {
  return {
    tavilyKey: resolve('tavilyKey'),
    tavilyUrl: (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, ''),
    llmBaseUrl: resolve('llmBaseUrl').replace(/\/+$/, ''),
    llmKey: resolve('llmKey'),
    llmModel: resolve('llmModel'),
    engineEnabled: process.env.ENGINE_ENABLED !== 'false'
  };
}

export const SETTING_DEFAULTS = {
  intervalMinutes: 60,
  paused: false,
  topicsPerRun: 6,
  resultsPerTopic: 5,
  searchDays: 2,
  maxArticlesPerRun: 15,
  concurrency: 3,
  minSourceChars: 700
};

export const SETTING_LIMITS = {
  intervalMinutes: [5, 1440],
  topicsPerRun: [1, 40],
  resultsPerTopic: [1, 10],
  searchDays: [1, 14],
  maxArticlesPerRun: [1, 60],
  concurrency: [1, 6],
  minSourceChars: [200, 5000]
};

export const REGIONS = [
  { id: 'MY', label: 'Malaysia', country: 'MY', terms: 'Malaysia' },
  { id: 'ASEAN', label: 'ASEAN', country: '', terms: 'Southeast Asia ASEAN Singapore Indonesia Thailand Vietnam Philippines' },
  { id: 'CN', label: 'China', country: 'CN', terms: 'China' },
  { id: 'JPKR', label: 'Japan & South Korea', country: '', terms: 'Japan South Korea' },
  { id: 'WEST', label: 'Europe & US', country: '', terms: 'United States Europe' },
  { id: 'WORLD', label: 'World', country: '', terms: 'global' }
];

export const SECTIONS = [
  { id: 'business', terms: 'business companies deals' },
  { id: 'energy', terms: 'energy renewable solar power grid' },
  { id: 'technology', terms: 'technology AI semiconductors' },
  { id: 'economy', terms: 'economy markets inflation trade' },
  { id: 'policy', terms: 'government policy regulation' }
];

export function buildSeedTopics() {
  const topics = [];
  for (const region of REGIONS) {
    for (const section of SECTIONS) {
      topics.push({
        query: `${region.terms} ${section.terms} news`,
        region: region.label,
        country: region.country,
        section: section.id
      });
    }
  }
  return topics;
}
