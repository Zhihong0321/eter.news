import { engineEnv } from './config.js';
import { engineDbEnabled, ensureEngineSchema, q } from './store.js';
import { nextRunInfo, schedulerError } from './scheduler.js';
import { engineStatus } from './pipeline.js';

const HOUR = 3_600_000;
// The scheduler ticks every 30s, so a run this late means the loop is stuck.
const OVERDUE_GRACE_MS = 15 * 60_000;
// No new article for this long (or 3 intervals, if longer) means the pipeline is not delivering.
const MIN_STALE_MS = 6 * HOUR;

const iso = (v) => (v ? new Date(v).toISOString() : null);
const verdict = (state, problems) => ({ healthy: false, state, problems });

// One-call answer to "is the news engine running and delivering?". Safe for a
// public endpoint: counts and timestamps only, no error text or credentials.
export async function pipelineHealth(now = Date.now()) {
  if (!engineEnv().engineEnabled) return verdict('disabled', ['ENGINE_ENABLED=false - the scheduler is switched off']);
  if (!engineDbEnabled()) return verdict('no-db', ['DATABASE_URL is not set - the scheduler cannot start']);

  await ensureEngineSchema();
  const [schedule, { rows: [last] }, { rows: [ok] }, { rows: [pub] }] = await Promise.all([
    nextRunInfo(),
    q(`select id, status, trigger, started_at, finished_at, found, fresh, published, rejected, failed
         from engine_runs order by id desc limit 1`),
    q(`select max(finished_at) as at from engine_runs where status in ('done', 'partial')`),
    q(`select max(enriched_at) as at,
              count(*) filter (where enriched_at > now() - interval '24 hours')::int as last24h
         from article_enrichments where status = 'enriched'`)
  ]);

  const running = engineStatus().running;
  const problems = [];
  if (schedule.state === 'unconfigured') problems.push(`engine not configured: missing ${schedule.missing.join(', ')}`);
  if (schedule.state === 'paused') problems.push('schedule is paused - no automatic runs');
  if (schedulerError()) problems.push('scheduler tick is failing (see server logs)');

  if (schedule.state === 'scheduled' && !running) {
    const lateMs = now - Date.parse(schedule.nextRunAt);
    if (lateMs > OVERDUE_GRACE_MS) problems.push(`next run was due ${Math.round(lateMs / 60_000)} min ago and has not started`);
  }
  if (last?.status === 'failed') problems.push(`last run #${last.id} failed`);

  const staleAfterMs = Math.max(MIN_STALE_MS, 3 * schedule.settings.intervalMinutes * 60_000);
  const publishedAt = pub?.at ? new Date(pub.at) : null;
  if (!publishedAt) problems.push('no published articles yet');
  else if (now - publishedAt.getTime() > staleAfterMs) {
    problems.push(`no new article for ${Math.round((now - publishedAt.getTime()) / HOUR)}h (limit ${Math.round(staleAfterMs / HOUR)}h)`);
  }

  return {
    healthy: problems.length === 0,
    state: running ? 'running' : schedule.state,
    problems,
    schedule: { intervalMinutes: schedule.settings.intervalMinutes, nextRunAt: schedule.nextRunAt },
    lastRun: last && {
      id: last.id, status: last.status, trigger: last.trigger,
      startedAt: iso(last.started_at), finishedAt: iso(last.finished_at),
      found: last.found, fresh: last.fresh, published: last.published, rejected: last.rejected, failed: last.failed
    },
    lastSuccessAt: iso(ok?.at),
    lastPublishedAt: iso(publishedAt),
    publishedLast24h: pub?.last24h ?? 0
  };
}
