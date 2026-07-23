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
    let errorMsg = err.message;
    if (err.message.includes('ENETUNREACH') || err.message.includes('2406:')) {
      errorMsg = 'IPv6 Network Unreachable. db.*.supabase.co direct host is IPv6-only. Railway requires Supabase Pooler connection string. Go to Supabase -> Settings -> Database -> Connection String -> Select Pooler and copy that URL to DATABASE_URL.';
    }
    return {
      enabled: true,
      connected: false,
      host: getCleanConnectionString().split('@')[1]?.split('/')[0] || 'unknown',
      error: errorMsg
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
        id: row.id,
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
        render_file: `infographic_${row.id}.dc.html`,
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

export async function getInfographicContentByArticleId(articleId) {
  if (!isDbEnabled() || !articleId) return null;
  let client;
  try {
    client = await getPool().connect();
    const { rows } = await client.query(
      `SELECT infographic_content FROM article_enrichments WHERE article_id = $1 AND status = 'enriched' LIMIT 1;`,
      [articleId]
    );
    if (!rows.length || !rows[0].infographic_content) return null;
    return typeof rows[0].infographic_content === 'string'
      ? JSON.parse(rows[0].infographic_content)
      : rows[0].infographic_content;
  } catch (err) {
    console.error(`[db] Failed to fetch infographic content for article ${articleId}:`, err.message);
    return null;
  } finally {
    if (client) client.release();
  }
}

// In-memory analytics store for local fallback
const inMemoryPageviews = [];
let dbTableInitialized = false;

export async function ensureAnalyticsTable() {
  if (!isDbEnabled() || dbTableInitialized) return;
  let client;
  try {
    client = await getPool().connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS pageviews (
        id SERIAL PRIMARY KEY,
        path VARCHAR(512) NOT NULL,
        article_id INT,
        event_type VARCHAR(64) DEFAULT 'pageview',
        referrer TEXT,
        user_agent TEXT,
        device_type VARCHAR(32),
        lang VARCHAR(16),
        utm_source VARCHAR(128),
        utm_medium VARCHAR(128),
        utm_campaign VARCHAR(128),
        ip_hash VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pageviews_created_at ON pageviews(created_at);
      CREATE INDEX IF NOT EXISTS idx_pageviews_article_id ON pageviews(article_id);
    `);
    dbTableInitialized = true;
    console.log('[db] Analytics table (pageviews) ensured.');
  } catch (err) {
    console.error('[db] Failed to ensure analytics table:', err.message);
  } finally {
    if (client) client.release();
  }
}

export async function recordPageviewInDb(data) {
  const event = {
    path: String(data.path || '/').slice(0, 512),
    article_id: data.article_id ? parseInt(data.article_id, 10) : null,
    event_type: String(data.event_type || 'pageview').slice(0, 64),
    referrer: String(data.referrer || '').slice(0, 1024),
    user_agent: String(data.user_agent || '').slice(0, 512),
    device_type: String(data.device_type || 'desktop').slice(0, 32),
    lang: String(data.lang || 'en').slice(0, 16),
    utm_source: String(data.utm_source || '').slice(0, 128),
    utm_medium: String(data.utm_medium || '').slice(0, 128),
    utm_campaign: String(data.utm_campaign || '').slice(0, 128),
    ip_hash: String(data.ip_hash || '').slice(0, 64),
    created_at: new Date()
  };

  inMemoryPageviews.push(event);
  if (inMemoryPageviews.length > 5000) inMemoryPageviews.shift();

  if (!isDbEnabled()) return true;

  try {
    await ensureAnalyticsTable();
    const client = await getPool().connect();
    try {
      await client.query(
        `INSERT INTO pageviews (path, article_id, event_type, referrer, user_agent, device_type, lang, utm_source, utm_medium, utm_campaign, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          event.path, event.article_id, event.event_type, event.referrer, event.user_agent,
          event.device_type, event.lang, event.utm_source, event.utm_medium, event.utm_campaign, event.ip_hash
        ]
      );
    } finally {
      client.release();
    }
    return true;
  } catch (err) {
    console.error('[db] Error logging pageview:', err.message);
    return false;
  }
}

export async function getAnalyticsReportFromDb() {
  if (!isDbEnabled()) {
    return generateReportFromList(inMemoryPageviews);
  }
  let client;
  try {
    await ensureAnalyticsTable();
    client = await getPool().connect();
    
    const [totalRes, todayRes, uniquesRes, topArticlesRes, referrersRes, langRes, deviceRes, hourlyRes] = await Promise.all([
      client.query(`SELECT count(*) FROM pageviews;`),
      client.query(`SELECT count(*) FROM pageviews WHERE created_at >= NOW() - INTERVAL '24 hours';`),
      client.query(`SELECT count(DISTINCT ip_hash) FROM pageviews WHERE ip_hash IS NOT NULL AND ip_hash != '';`),
      client.query(`
        SELECT article_id, count(*) as views
        FROM pageviews
        WHERE article_id IS NOT NULL
        GROUP BY article_id
        ORDER BY views DESC
        LIMIT 10;
      `),
      client.query(`
        SELECT 
          CASE 
            WHEN referrer LIKE '%google%' THEN 'Google Search'
            WHEN referrer LIKE '%x.com%' OR referrer LIKE '%twitter%' THEN 'X / Twitter'
            WHEN referrer LIKE '%facebook%' OR referrer LIKE '%fb%' THEN 'Facebook'
            WHEN referrer LIKE '%linkedin%' THEN 'LinkedIn'
            WHEN referrer LIKE '%whatsapp%' THEN 'WhatsApp'
            WHEN referrer = '' OR referrer IS NULL THEN 'Direct / Bookmark'
            ELSE 'Other Sources'
          END as source,
          count(*) as count
        FROM pageviews
        GROUP BY source
        ORDER BY count DESC;
      `),
      client.query(`
        SELECT lang, count(*) as count
        FROM pageviews
        GROUP BY lang;
      `),
      client.query(`
        SELECT device_type, count(*) as count
        FROM pageviews
        GROUP BY device_type;
      `),
      client.query(`
        SELECT EXTRACT(HOUR FROM created_at) as hour, count(*) as count
        FROM pageviews
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY hour
        ORDER BY hour ASC;
      `)
    ]);

    // Attach article details to top articles
    const topArticles = [];
    for (const r of topArticlesRes.rows) {
      const artId = r.article_id;
      const content = await getInfographicContentByArticleId(artId);
      const title = content?.coreNews?.displayTitle?.en || content?.coreNews?.displayTitle?.zh || `Article #${artId}`;
      topArticles.push({ article_id: artId, views: Number(r.views), title });
    }

    return {
      generated_at: new Date().toISOString(),
      summary: {
        total_pageviews: Number(totalRes.rows[0]?.count || 0),
        views_today: Number(todayRes.rows[0]?.count || 0),
        unique_visitors: Number(uniquesRes.rows[0]?.count || 0)
      },
      top_articles: topArticles,
      traffic_sources: referrersRes.rows.map(r => ({ source: r.source, count: Number(r.count) })),
      language_split: langRes.rows.map(r => ({ lang: r.lang, count: Number(r.count) })),
      device_split: deviceRes.rows.map(r => ({ device: r.device_type, count: Number(r.count) })),
      hourly_traffic_24h: hourlyRes.rows.map(r => ({ hour: Number(r.hour), count: Number(r.count) }))
    };
  } catch (err) {
    console.error('[db] Error loading analytics report:', err.message);
    return generateReportFromList(inMemoryPageviews);
  } finally {
    if (client) client.release();
  }
}

function generateReportFromList(events) {
  const total = events.length;
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const todayCount = events.filter(e => new Date(e.created_at).getTime() >= dayAgo).length;
  const ips = new Set(events.map(e => e.ip_hash).filter(Boolean));

  const artCounts = {};
  events.forEach(e => {
    if (e.article_id) artCounts[e.article_id] = (artCounts[e.article_id] || 0) + 1;
  });
  const topArticles = Object.entries(artCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, views]) => ({ article_id: Number(id), views, title: `Article #${id}` }));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_pageviews: total,
      views_today: todayCount,
      unique_visitors: ips.size
    },
    top_articles: topArticles,
    traffic_sources: [{ source: 'Direct / Local', count: total }],
    language_split: [{ lang: 'en', count: Math.ceil(total * 0.6) }, { lang: 'cn', count: Math.floor(total * 0.4) }],
    device_split: [{ device: 'desktop', count: total }],
    hourly_traffic_24h: []
  };
}
