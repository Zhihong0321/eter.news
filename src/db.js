import pg from 'pg';

let pool = null;

export function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
}

export function getPool() {
  if (!pool && isDbEnabled()) {
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    const ssl = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString, ssl });
  }
  return pool;
}

export async function getPublishedArticlesFromDb() {
  if (!isDbEnabled()) {
    return { generated_at: new Date().toISOString(), count: 0, articles: [], skipped: { total: 0 } };
  }

  const client = await getPool().connect();
  try {
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

    return {
      generated_at: new Date().toISOString(),
      count: articles.length,
      articles,
      skipped: { total: 0 }
    };
  } finally {
    client.release();
  }
}
