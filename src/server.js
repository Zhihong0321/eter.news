import dns from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getPublishedArticlesFromDb, getInfographicContentByArticleId, isDbEnabled, checkDbHealth, recordPageviewInDb, getAnalyticsReportFromDb } from './db.js';
import { renderInfographicDocument } from '../templates/infographic/render.js';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const EDITORIAL_OUTPUT_DIR = path.resolve(__dirname, '../editorial-output');
const PORT = Number(process.env.PORT) || 8080;

const PUBLISHED_CACHE_MS = 5000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

let publishedCache = { at: 0, value: null };

async function getPublishedArticles() {
  const now = Date.now();
  if (publishedCache.value && now - publishedCache.at < PUBLISHED_CACHE_MS) {
    return publishedCache.value;
  }
  const value = await getPublishedArticlesFromDb();
  publishedCache = { at: now, value };
  return value;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html'
    : pathname === '/read' || pathname === '/read/' ? '/read.html'
    : pathname === '/article' || pathname === '/article/' ? '/article.html'
    : pathname === '/about-0pc' || pathname === '/about-0pc/' ? '/about-0pc.html'
    : pathname;

  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=60'
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function serveRendered(req, res, filename) {
  const name = decodeURIComponent(filename);

  if (name === 'support.js' || name === '/support.js') {
    const supportPath = path.resolve(__dirname, '../templates/infographic/support.js');
    try {
      const data = await fs.readFile(supportPath);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400'
      });
      res.end(data);
      return;
    } catch {}
  }

  const filePath = path.join(EDITORIAL_OUTPUT_DIR, name);
  if (filePath.startsWith(`${EDITORIAL_OUTPUT_DIR}${path.sep}`)) {
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(name);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[ext] || 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600'
      });
      res.end(data);
      return;
    } catch {}
  }

  const idMatch = name.match(/^infographic_(\d+)\.dc\.html$/);
  if (idMatch) {
    const articleId = parseInt(idMatch[1], 10);
    const content = await getInfographicContentByArticleId(articleId);
    if (content) {
      try {
        const entry = content.infographicContent
          ? content
          : { infographicContent: content, coreNews: content.coreNews || {} };
        const html = renderInfographicDocument(entry, {
          defaultLang: 'en',
          colorway: 'masela',
          animations: true
        });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600'
        });
        res.end(html);
        return;
      } catch (renderErr) {
        console.error('[server] Dynamic infographic rendering error:', renderErr);
      }
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Rendered infographic file not found');
}

async function generateSitemapXml() {
  const published = await getPublishedArticles();
  const articles = published.articles || [];
  let itemsXml = '';
  for (const a of articles) {
    const title = (a.displayTitle?.en || a.displayTitle?.zh || 'News Article').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const loc = `https://eter.my/rendered/${a.render_file || `infographic_${a.id}.dc.html`}`;
    const pubDate = String(a.published_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    itemsXml += `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${a.published_at || new Date().toISOString()}</lastmod>\n    <news:news>\n      <news:publication>\n        <news:name>Eter News</news:name>\n        <news:language>en</news:language>\n      </news:publication>\n      <news:publication_date>${pubDate}</news:publication_date>\n      <news:title>${title}</news:title>\n    </news:news>\n  </url>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://eter.my/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://eter.my/read</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
${itemsXml}</urlset>`;
}

async function generateRssXml() {
  const published = await getPublishedArticles();
  const articles = published.articles || [];
  let itemsXml = '';
  for (const a of articles) {
    const title = (a.displayTitle?.en || a.displayTitle?.zh || 'News Article').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const desc = (a.summary?.en || a.summary?.zh || '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const loc = `https://eter.my/rendered/${a.render_file || `infographic_${a.id}.dc.html`}`;
    const pubDate = new Date(a.published_at || Date.now()).toUTCString();
    itemsXml += `    <item>\n      <title>${title}</title>\n      <link>${loc}</link>\n      <guid isPermaLink="true">${loc}</guid>\n      <pubDate>${pubDate}</pubDate>\n      <description>${desc}</description>\n    </item>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Eter News — Asian Business &amp; Regional Coverage</title>
    <link>https://eter.my/</link>
    <description>Bilingual independent news desk presenting clear, curated regional coverage in English and Chinese.</description>
    <language>en-us</language>
${itemsXml}  </channel>
</rss>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/health' || pathname === '/api/health') {
      const dbHealth = await checkDbHealth();
      return sendJson(res, 200, {
        ok: true,
        service: 'eter-news-portal',
        db: dbHealth,
        timestamp: new Date().toISOString()
      });
    }

    if (pathname === '/sitemap.xml') {
      const xml = await generateSitemapXml();
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return res.end(xml);
    }

    if (pathname === '/feed.xml' || pathname === '/rss.xml') {
      const xml = await generateRssXml();
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return res.end(xml);
    }

    if (pathname === '/api/llm/latest.json') {
      const published = await getPublishedArticles();
      const articles = (published.articles || []).map(a => ({
        id: a.id,
        title: a.displayTitle,
        summary: a.summary,
        key_facts: a.keyFacts,
        published_at: a.published_at,
        url: `https://eter.my/rendered/${a.render_file || `infographic_${a.id}.dc.html`}`
      }));
      return sendJson(res, 200, {
        site: 'Eter News',
        publisher: 'Eternalgy Sdn Bhd',
        url: 'https://eter.my',
        updated_at: new Date().toISOString(),
        count: articles.length,
        articles
      });
    }

    if (pathname === '/api/analytics/event' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
          const ipHash = crypto.createHash('sha256').update(ip + (process.env.SALT || 'eter-news')).digest('hex').slice(0, 32);
          const userAgent = req.headers['user-agent'] || '';
          const isBot = /gptbot|perplexitybot|claudebot|google-extended|bytespider|bingbot|crawler|spider/i.test(userAgent);
          const country = (req.headers['cf-ipcountry'] || req.headers['x-country'] || req.headers['x-appengine-country'] || '').toString().trim().toUpperCase();
          
          await recordPageviewInDb({
            path: data.path || '/',
            article_id: data.article_id,
            event_type: data.event_type || 'pageview',
            referrer: data.referrer || req.headers['referer'] || '',
            user_agent: userAgent,
            device_type: data.device_type || (/mobile/i.test(userAgent) ? 'mobile' : /tablet/i.test(userAgent) ? 'tablet' : 'desktop'),
            lang: data.lang || 'en',
            utm_source: data.utm_source,
            utm_medium: data.utm_medium,
            utm_campaign: data.utm_campaign,
            ip_hash: ipHash,
            scroll_depth: data.scroll_depth || 0,
            read_time_sec: data.read_time_sec || 0,
            is_bot: isBot,
            country: country,
            share_platform: data.share_platform || ''
          });
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }

    if (pathname === '/api/analytics/report' && req.method === 'GET') {
      const report = await getAnalyticsReportFromDb();
      return sendJson(res, 200, report);
    }

    if (pathname === '/stats' || pathname === '/stats/' || pathname === '/analytics' || pathname === '/analytics/') {
      return await serveStatic(req, res, '/stats.html');
    }

    if (pathname === '/api/news' && req.method === 'GET') {
      const articles = await getPublishedArticles();
      return sendJson(res, 200, articles);
    }

    if (pathname.startsWith('/rendered/')) {
      const filename = pathname.replace(/^\/rendered\//, '');
      return await serveRendered(req, res, filename);
    }

    if (pathname === '/support.js') {
      return await serveRendered(req, res, 'support.js');
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    return await serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});


const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (!invokedPath || invokedPath.toLowerCase().endsWith('server.js')) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[eter.news] Public news portal running on 0.0.0.0:${PORT}`);
  });
}

