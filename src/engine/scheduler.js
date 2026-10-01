import { engineEnv } from './config.js';
import { engineDbEnabled, getSettings, listRuns } from './store.js';
import { engineStatus, enginePrereqs, startRun } from './pipeline.js';

const TICK_MS = 30_000;
const FIRST_RUN_DELAY_MS = 20_000;

let timer = null;
let bootAt = Date.now();
let lastTickError = null;

// Next scheduled start, derived from the last run so a restart doesn't reset
// the cadence. nextRunAt is null while paused or unconfigured.
export async function nextRunInfo() {
  const settings = await getSettings();
  const missing = enginePrereqs();
  if (missing.length) return { state: 'unconfigured', missing, nextRunAt: null, settings };
  if (settings.paused) return { state: 'paused', nextRunAt: null, settings };
  const [last] = await listRuns(1);
  const intervalMs = settings.intervalMinutes * 60_000;
  const due = last ? new Date(last.started_at).getTime() + intervalMs : 0;
  const earliest = bootAt + FIRST_RUN_DELAY_MS;
  return { state: 'scheduled', nextRunAt: new Date(Math.max(due, earliest)).toISOString(), settings };
}

async function tick() {
  try {
    if (engineStatus().running) return;
    const info = await nextRunInfo();
    if (info.state !== 'scheduled') return;
    if (Date.now() >= new Date(info.nextRunAt).getTime()) {
      await startRun('schedule');
    }
    lastTickError = null;
  } catch (err) {
    lastTickError = err.message;
    console.error('[engine] scheduler tick failed:', err.message);
  }
}

export function startScheduler() {
  if (timer) return;
  if (!engineEnv().engineEnabled) {
    console.log('[engine] disabled via ENGINE_ENABLED=false');
    return;
  }
  if (!engineDbEnabled()) {
    console.warn('[engine] DATABASE_URL not set — scheduler not started');
    return;
  }
  bootAt = Date.now();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[engine] scheduler started (tick ${TICK_MS / 1000}s)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function schedulerError() {
  return lastTickError;
}
