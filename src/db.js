import dns from 'node:dns';
import pg from 'pg';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}


let pool = null;

export function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
}

function getCleanConnectionString() {
  let connectionString = (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
  // Fix unescaped @ symbol in password if user pasted raw password like postgres:@Eternalgy2026@...
  if (connectionString.includes('@') && connectionString.indexOf('@') !== connectionString.lastIndexOf('@')) {
    const lastAt = connectionString.lastIndexOf('@');
    const firstColon = connectionString.indexOf(':', connectionString.indexOf('://') + 3);
    if (firstColon > 0 && firstColon < lastAt) {
      const user = connectionString.slice(0, firstColon + 1);
      const rawPass = connectionString.slice(firstColon + 1, lastAt);
      const hostPath = connectionString.slice(lastAt);
      const encodedPass = rawPass.replace(/@/g, '%40');
      connectionString = `${user}${encodedPass}${hostPath}`;
    }
  }
  return connectionString;
}

export function getPool() {
  if (!pool && isDbEnabled()) {
    const connectionString = getCleanConnectionString();
    const host = connectionString.split('@')[1] || 'unknown';
    console.log('[db] Initializing pg pool for database host:', host);
    const ssl = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString, ssl, connectionTimeoutMillis: 10000 });
  }
  return pool;
}

export async function checkDbHealth() {
  if (!isDbEnabled()) {
    return { enabled: false, connected: false, error: 'DATABASE_URL is not set in environment' };
  }
  let client;
  try {
    const connStr = getCleanConnectionString();
    const host = connStr.split('@')[1]?.split('/')[0] || 'unknown';
    client = await getPool().connect();
    const res = await client.query('SELECT count(*) FROM article_enrichments WHERE status = \'enriched\';');
    return {
      enabled: true,
      connected: true,
      host,
      enrichedArticlesInDb: Number(res.rows[0]?.count || 0),
      error: null
    };
  } catch (err) {
    console.error('[db] Health check failed:', err.message);
    return {
      enabled: true,
      connected: false,
      host: getCleanConnectionString().split('@')[1]?.split('/')[0] || 'unknown',
      error: err.message
    };
  } finally {
    if (client) client.release();
  }
}

export async function getPublishedArticlesFromDb() {
  if (!isDbEnabled()) {
    console.warn('[db] isDbEnabled is FALSE. DATABASE_URL is missing in environment variables.');
    return { generated_at: new Date().toISOString(), count: 0, articles: [], skipped: { total: 0 }, dbStatus: 'disabled' };
  }

  let client;
  try {
    client = await getPool().connect();
    const queryStr = `
      SELECT 
        a.id,
        a.url,
        a.source,
        a.country,
        a.section,
        a.tags,
        a.author,
        a.published_at,
        a.fetched_at,
        e.infographic_content,
        e.enriched_at,
        e.status
      FROM article_enrichments e
      JOIN articles a ON e.article_id = a.id
      WHERE e.status = 'enriched'
        AND e.infographic_content IS NOT NULL
      ORDER BY COALESCE(a.published_at, a.fetched_at, e.enriched_at) DESC
      LIMIT 300;
    `;
    const { rows } = await client.query(queryStr);

    const articles = [];
    for (const row of rows) {
      const content = typeof row.infographic_content === 'string'
        ? JSON.parse(row.infographic_content)
        : (row.infographic_content || {});
      
      const display = content.coreNews || content;
      const displayTitle = display.displayTitle;
      const summary = display.summary;

      if (!row.url || !displayTitle?.en || !displayTitle?.zh || !summary?.en || !summary?.zh) {
        continue;
      }

      const publishedAt = row.published_at
        ? new Date(row.published_at).toISOString()
        : row.fetched_at
        ? new Date(row.fetched_at).toISOString()
        : row.enriched_at
        ? new Date(row.enriched_at).toISOString()
        : new Date().toISOString();

      articles.push({
        url: String(row.url).trim(),
        source: row.source || '',
        country: row.country || '',
        section: row.section || '',
        tags: Array.isArray(row.tags) ? row.tags : [],
        author: row.author || '',
        displayTitle,
        summary,
        keyFacts: Array.isArray(display.keyFacts) ? display.keyFacts : [],
        published_at: publishedAt,
        publication_status: 'rendered',
        rendered_at: row.enriched_at ? new Date(row.enriched_at).toISOString() : publishedAt
      });
    }

    console.log(`[db] Successfully loaded ${articles.length} published articles from DB.`);
    return {
      generated_at: new Date().toISOString(),
      count: articles.length,
      articles,
      skipped: { total: 0 },
      dbStatus: 'connected'
    };
  } catch (err) {
    console.error('[db] Failed to fetch published articles:', err.stack || err.message);
    return {
      generated_at: new Date().toISOString(),
      count: 0,
      articles: [],
      skipped: { total: 0 },
      error: err.message,
      dbStatus: 'error'
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}
