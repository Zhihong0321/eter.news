import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getPublishedArticlesFromDb, isDbEnabled, checkDbHealth } from './db.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
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

    if (pathname === '/api/news' && req.method === 'GET') {
      const articles = await getPublishedArticles();
      return sendJson(res, 200, articles);
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


