// CRUD for the LLM control plane (llm_providers / llm_models / llm_task_routes).
// Ported verbatim from news-fetcher-v2's src/db/llm-config.js — same tables,
// same SQL. Lives on the Hub so a local factory dashboard (no DATABASE_URL of
// its own) can manage providers/models/routes entirely over HTTP, via
// server.js's /api/hub/llm/* routes. API keys never leave this process in
// plaintext: listProviders() masks them, and getProviderSecret() is only used
// internally by the /api/hub/llm/test route to make the outbound call itself.
import { query, getPool, isDbEnabled } from './db.js';

export const ROUTABLE_TASKS = ['distill', 'tag', 'enrich'];
export const API_STYLES = ['anthropic', 'openai'];

export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}${'*'.repeat(6)}`;
  return `${value.slice(0, 6)}${'*'.repeat(6)}${value.slice(-4)}`;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function assertTask(task) {
  if (!ROUTABLE_TASKS.includes(task)) {
    throw new Error(`Unknown task "${task}" (expected one of: ${ROUTABLE_TASKS.join(', ')})`);
  }
}

function assertApiStyle(style) {
  if (!API_STYLES.includes(style)) {
    throw new Error(`Unknown api_style "${style}" (expected one of: ${API_STYLES.join(', ')})`);
  }
}

export async function listProviders() {
  if (!isDbEnabled()) return [];
  const { rows } = await query(`
    select p.id, p.name, p.api_style, p.base_url, p.api_key, p.enabled, p.notes,
           coalesce(
             json_agg(
               json_build_object('id', m.id, 'model', m.model, 'label', m.label, 'enabled', m.enabled)
               order by m.model
             ) filter (where m.id is not null),
             '[]'
           ) as models
      from llm_providers p
      left join llm_models m on m.provider_id = p.id
     group by p.id
     order by p.name
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    apiStyle: row.api_style,
    baseUrl: row.base_url,
    apiKeyMasked: maskKey(row.api_key),
    enabled: row.enabled,
    notes: row.notes,
    models: (row.models || []).map((m) => ({ ...m, id: Number(m.id) }))
  }));
}

/** Full row INCLUDING the plaintext key. Used only by the /test route. */
export async function getProviderSecret(providerId) {
  if (!isDbEnabled()) return null;
  const { rows } = await query(
    'select id, name, api_style, base_url, api_key, enabled from llm_providers where id = $1',
    [providerId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    name: row.name,
    apiStyle: row.api_style,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: row.enabled
  };
}

export async function createProvider({ name, apiStyle = 'anthropic', baseUrl, apiKey, enabled = true, notes = null }) {
  if (!String(name || '').trim()) throw new Error('Provider name is required');
  if (!normalizeBaseUrl(baseUrl)) throw new Error('Provider baseUrl is required');
  if (!String(apiKey || '').trim()) throw new Error('Provider apiKey is required');
  assertApiStyle(apiStyle);
  const { rows } = await query(
    `insert into llm_providers (name, api_style, base_url, api_key, enabled, notes)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [String(name).trim(), apiStyle, normalizeBaseUrl(baseUrl), String(apiKey).trim(), enabled, notes]
  );
  return Number(rows[0].id);
}

export async function updateProvider(providerId, patch = {}) {
  const sets = [];
  const params = [];
  const push = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

  if (patch.name !== undefined) push('name', String(patch.name).trim());
  if (patch.apiStyle !== undefined) { assertApiStyle(patch.apiStyle); push('api_style', patch.apiStyle); }
  if (patch.baseUrl !== undefined) push('base_url', normalizeBaseUrl(patch.baseUrl));
  if (patch.apiKey) push('api_key', String(patch.apiKey).trim());
  if (patch.enabled !== undefined) push('enabled', Boolean(patch.enabled));
  if (patch.notes !== undefined) push('notes', patch.notes);
  if (!sets.length) return false;

  params.push(providerId);
  const { rowCount } = await query(
    `update llm_providers set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`,
    params
  );
  return rowCount > 0;
}

export async function deleteProvider(providerId) {
  const { rowCount } = await query('delete from llm_providers where id = $1', [providerId]);
  return rowCount > 0;
}

export async function addModel(providerId, { model, label = null, enabled = true }) {
  if (!String(model || '').trim()) throw new Error('Model id is required');
  const { rows } = await query(
    `insert into llm_models (provider_id, model, label, enabled)
     values ($1, $2, $3, $4)
     on conflict (provider_id, model) do update set label = excluded.label, enabled = excluded.enabled
     returning id`,
    [providerId, String(model).trim(), label, enabled]
  );
  return Number(rows[0].id);
}

export async function deleteModel(modelId) {
  const { rowCount } = await query('delete from llm_models where id = $1', [modelId]);
  return rowCount > 0;
}

export async function listRoutes() {
  const empty = Object.fromEntries(ROUTABLE_TASKS.map((task) => [task, []]));
  if (!isDbEnabled()) return empty;
  const { rows } = await query(`
    select r.id, r.task, r.position, r.enabled,
           m.id as model_id, m.model,
           p.id as provider_id, p.name as provider_name, p.enabled as provider_enabled
      from llm_task_routes r
      join llm_models m    on m.id = r.model_id
      join llm_providers p on p.id = m.provider_id
     order by r.task, r.position
  `);
  const grouped = { ...empty };
  for (const row of rows) {
    if (!grouped[row.task]) grouped[row.task] = [];
    grouped[row.task].push({
      id: Number(row.id),
      position: row.position,
      enabled: row.enabled && row.provider_enabled,
      modelId: Number(row.model_id),
      model: row.model,
      providerId: Number(row.provider_id),
      providerName: row.provider_name
    });
  }
  return grouped;
}

export async function setTaskChain(task, entries = []) {
  assertTask(task);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('delete from llm_task_routes where task = $1', [task]);
    for (const [index, entry] of entries.entries()) {
      const modelId = Number(entry?.modelId);
      if (!Number.isInteger(modelId)) throw new Error(`Chain entry ${index} is missing a modelId`);
      await client.query(
        'insert into llm_task_routes (task, position, model_id, enabled) values ($1, $2, $3, $4)',
        [task, index, modelId, entry.enabled !== false]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return entries.length;
}

/** Same anthropic/openai request-shaping used by news-fetcher-v2's llm-registry.js. */
export function buildRequest(provider, prompt, { maxTokens = 512 } = {}) {
  if (provider.apiStyle === 'openai') {
    return {
      url: `${provider.baseUrl}/v1/chat/completions`,
      headers: {
        authorization: `Bearer ${provider.token}`,
        'content-type': 'application/json'
      },
      body: {
        model: provider.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      }
    };
  }
  return {
    url: `${provider.baseUrl}/v1/messages`,
    headers: {
      'x-api-key': provider.token,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: {
      model: provider.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }
  };
}

export function extractText(payload, apiStyle) {
  if (apiStyle === 'openai') {
    return String(payload?.choices?.[0]?.message?.content || '');
  }
  return (payload?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}
