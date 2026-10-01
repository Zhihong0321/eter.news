import crypto from 'node:crypto';
import { engineEnv, CREDENTIALS } from './config.js';
import * as store from './store.js';
import { engineStatus, enginePrereqs, startRun, requestStop } from './pipeline.js';
import { nextRunInfo, schedulerError } from './scheduler.js';
import { pingTavily } from './tavily.js';
import { pingLlm } from './llm.js';
import { canEncrypt, secretBase } from './secrets.js';

const COOKIE = 'eter_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

// Admin auth has no required environment variable: the password is a scrypt
// hash in Postgres (set through the first-run setup form). HUB_API_KEY, when
// set, still works as an additional admin password / x-hub-key header.
function envKey() {
  return process.env.HUB_API_KEY || '';
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function signingKey() {
  return `${secretBase()}|${store.adminSalt() || 'env'}|${envKey()}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('hex');
}

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}

function validToken(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function isAdminConfigured() {
  return store.adminConfigured() || Boolean(envKey());
}

function passwordMatches(candidate) {
  const value = String(candidate || '');
  if (!value) return false;
  if (envKey() && safeEqual(value, envKey())) return true;
  return store.verifyAdminPassword(value);
}

export function isAdminAuthenticated(req) {
  if (!isAdminConfigured()) return false;
  if (envKey() && req.headers['x-hub-key'] && safeEqual(req.headers['x-hub-key'], envKey())) return true;
  return validToken(readCookie(req, COOKIE));
}

// One-time setup code, printed to the server log at boot while no admin
// password exists. Whoever can read the deploy logs can claim the dashboard;
// nobody else can, even though the setup endpoint is public.
let setupCode = null;

function ensureSetupCode() {
  if (!setupCode) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  }
  return setupCode;
}

export async function announceAdminSetup() {
  if (!store.engineDbEnabled()) return;
  await store.ensureEngineSchema();
  if (isAdminConfigured()) return;
  console.log(`
  ADMIN SETUP REQUIRED — open /admin and enter this one-time setup code: ${ensureSetupCode()}
`);
}

function sessionCookie(req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`;
}

// Failed-login throttle: 8 attempts per 10 minutes per IP.
const attempts = new Map();

function throttled(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  attempts.set(ip, list);
  return list.length >= 8;
}

function noteFailure(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Returns true when the request was handled. `helpers` supplies the server's
// JSON reader/writer so this module stays free of server.js internals.
export async function handleAdminApi(req, res, pathname, url, { sendJson, readJsonBody }) {
  if (!pathname.startsWith('/api/admin/')) return false;
  const route = pathname.slice('/api/admin/'.length);
  const method = req.method;
  const reply = (status, body, headers) => {
    sendJson(res, status, body, headers);
    return true;
  };

  try {
    if (route === 'status' && method === 'GET') {
      if (!store.engineDbEnabled()) return reply(503, { ok: false, error: 'DATABASE_URL is not set — the engine needs the database' });
      await store.ensureEngineSchema();
      return reply(200, { ok: true, configured: isAdminConfigured() });
    }

    if ((route === 'login' || route === 'setup') && method === 'POST') {
      if (!store.engineDbEnabled()) return reply(503, { ok: false, error: 'DATABASE_URL is not set — the engine needs the database' });
      await store.ensureEngineSchema();
      const ip = clientIp(req);
      if (throttled(ip)) return reply(429, { ok: false, error: 'Too many attempts — try again in a few minutes' });
      const body = await readJsonBody(req);

      if (route === 'setup') {
        if (isAdminConfigured()) return reply(409, { ok: false, error: 'Admin is already set up — sign in instead' });
        if (!safeEqual(String(body.code || '').trim().toUpperCase(), ensureSetupCode())) {
          noteFailure(ip);
          return reply(401, { ok: false, error: 'Wrong setup code — it is printed in the server (Railway deploy) logs' });
        }
        await store.setAdminPassword(body.password);
        if (body.credentials && typeof body.credentials === 'object') await store.saveCredentials(body.credentials);
        setupCode = null;
        return reply(200, { ok: true }, { 'set-cookie': sessionCookie(req) });
      }

      if (!isAdminConfigured()) return reply(409, { ok: false, needsSetup: true, error: 'Admin is not set up yet' });
      if (!passwordMatches(body.password ?? body.key)) {
        noteFailure(ip);
        return reply(401, { ok: false, error: 'Wrong password' });
      }
      return reply(200, { ok: true }, { 'set-cookie': sessionCookie(req) });
    }

    if (route === 'logout' && method === 'POST') {
      return reply(200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (!isAdminAuthenticated(req)) return reply(401, { ok: false, error: 'Authentication required' });

    // State-changing calls must come from our own origin (CSRF guard on top of SameSite).
    if (method !== 'GET' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (new URL(req.headers.origin).host !== host) return reply(403, { ok: false, error: 'Cross-origin request blocked' });
    }

    if (!store.engineDbEnabled()) {
      return reply(503, { ok: false, error: 'DATABASE_URL is not set — the engine needs the database' });
    }

    if (route === 'state' && method === 'GET') {
      const env = engineEnv();
      const [overview, schedule, runs] = await Promise.all([store.getOverview(), nextRunInfo(), store.listRuns(25)]);
      return reply(200, {
        ok: true,
        now: new Date().toISOString(),
        engine: engineStatus(),
        schedule,
        schedulerError: schedulerError(),
        config: {
          llmBaseUrl: env.llmBaseUrl,
          llmModel: env.llmModel,
          tavilyConfigured: Boolean(env.tavilyKey),
          llmConfigured: Boolean(env.llmKey),
          missing: enginePrereqs()
        },
        overview,
        runs
      });
    }

    if (route === 'run' && method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      if (!id) throw httpError('id required');
      const afterId = Number(url.searchParams.get('after') || 0);
      const run = await store.getRun(id);
      if (!run) throw httpError('Run not found', 404);
      const [items, events] = await Promise.all([store.getRunItems(id), store.getEvents({ runId: id, afterId })]);
      return reply(200, { ok: true, run, items, events });
    }

    if (route === 'events' && method === 'GET') {
      const events = await store.getEvents({ afterId: Number(url.searchParams.get('after') || 0), limit: 100 });
      return reply(200, { ok: true, events });
    }

    if (route === 'run/start' && method === 'POST') {
      return reply(200, { ok: true, runId: await startRun('manual') });
    }

    if (route === 'run/stop' && method === 'POST') {
      return reply(200, { ok: requestStop() });
    }

    if (route === 'settings' && method === 'GET') {
      return reply(200, { ok: true, settings: await store.getSettings() });
    }
    if (route === 'settings' && method === 'POST') {
      return reply(200, { ok: true, settings: await store.updateSettings(await readJsonBody(req)) });
    }

    if (route === 'topics' && method === 'GET') {
      return reply(200, { ok: true, topics: await store.listTopics() });
    }
    if (route === 'topics' && method === 'POST') {
      const body = await readJsonBody(req);
      if (body.delete && body.id) {
        await store.deleteTopic(Number(body.id));
        return reply(200, { ok: true });
      }
      if (body.id && Object.keys(body).length === 2 && 'enabled' in body) {
        await store.setTopicEnabled(Number(body.id), body.enabled);
        return reply(200, { ok: true });
      }
      return reply(200, { ok: true, topic: await store.upsertTopic(body) });
    }

    if (route === 'failures' && method === 'GET') {
      return reply(200, { ok: true, items: await store.getFailedItems() });
    }

    if (route === 'articles' && method === 'GET') {
      return reply(200, { ok: true, articles: await store.getRecentArticles() });
    }

    if (route === 'password' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!passwordMatches(body.current)) return reply(401, { ok: false, error: 'Current password is wrong' });
      await store.setAdminPassword(body.next);
      // The signing key depends on the password salt, so every old session ends; keep this one.
      return reply(200, { ok: true }, { 'set-cookie': sessionCookie(req) });
    }

    if (route === 'credentials' && method === 'GET') {
      return reply(200, { ok: true, credentials: await store.credentialStatus(), canEncrypt: canEncrypt() });
    }
    if (route === 'credentials' && method === 'POST') {
      const body = await readJsonBody(req);
      if (body.clear) return reply(200, { ok: true, credentials: await store.clearCredential(String(body.clear)) });
      if (body.importFromEnv) {
        const patch = {};
        for (const [name, def] of Object.entries(CREDENTIALS)) {
          const fromEnv = (process.env[def.env] || '').trim();
          if (fromEnv) patch[name] = fromEnv;
        }
        return reply(200, { ok: true, imported: Object.keys(patch), credentials: await store.saveCredentials(patch) });
      }
      return reply(200, { ok: true, credentials: await store.saveCredentials(body) });
    }

    if (route === 'test' && method === 'POST') {
      const { target } = await readJsonBody(req);
      const check = async (fn) => {
        try { return await fn(); } catch (err) { return { ok: false, error: err.message }; }
      };
      const out = {};
      if (target === 'tavily' || target === 'all') out.tavily = await check(pingTavily);
      if (target === 'llm' || target === 'all') out.llm = await check(pingLlm);
      if (target === 'schema' || target === 'all') out.schema = await check(store.schemaCheck);
      return reply(200, { ok: true, ...out });
    }

    return reply(404, { ok: false, error: 'Unknown admin route' });
  } catch (err) {
    return reply(err.status || 500, { ok: false, error: err.message });
  }
}
