// Gather Monitor dashboard. Plain DOM + polling; all text is set via
// textContent so article titles / error strings can never inject markup.

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401 && path !== 'login' && path !== 'setup') {
    showLogin();
    throw new Error('Signed out');
  }
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const fmt = new Intl.NumberFormat('en');
const num = (n) => (n == null ? '–' : fmt.format(Number(n)));

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function until(iso) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'any moment';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function duration(run) {
  if (!run.finished_at) return run.status === 'running' ? 'running…' : '–';
  const s = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB');
const chip = (status) => h('span', { class: `chip ${status}` }, status);

// ---------------------------------------------------------------- state
const S = { state: null, selectedRun: null, lastEventId: 0, events: [], tab: 'topics', busy: false };

async function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  let configured = true;
  try {
    configured = (await api('status')).configured;
  } catch (err) {
    $('login-error').textContent = err.message;
  }
  $('login-form').hidden = !configured;
  $('setup-form').hidden = configured;
  (configured ? $('key') : $('setup-code')).focus();
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  const credentials = {};
  for (const [name, id] of [['tavilyKey', 'setup-tavily'], ['llmKey', 'setup-llm'], ['llmBaseUrl', 'setup-url'], ['llmModel', 'setup-model']]) {
    if ($(id).value.trim()) credentials[name] = $(id).value.trim();
  }
  try {
    await api('setup', { method: 'POST', body: { code: $('setup-code').value, password: $('setup-pass').value, credentials } });
    for (const id of ['setup-code', 'setup-pass', 'setup-tavily', 'setup-llm']) $(id).value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    await refresh();
    loadTab();
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('login', { method: 'POST', body: { password: $('key').value } });
    $('key').value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    await refresh();
    loadTab();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ------------------------------------------------------------- top bar
function renderTop(st) {
  const pill = $('engine-pill');
  let label;
  let cls;
  if (st.engine.running) { label = `Running · run #${st.engine.runId}`; cls = 'running'; }
  else if (st.schedule.state === 'unconfigured') { label = 'Not configured'; cls = 'unconfigured'; }
  else if (st.schedule.state === 'paused') { label = 'Schedule paused'; cls = 'paused'; }
  else { label = 'Idle'; cls = 'idle'; }
  pill.textContent = label;
  pill.className = `pill ${cls}`;

  const interval = st.schedule.settings.intervalMinutes;
  $('next-run').textContent = st.engine.running
    ? `started ${ago(st.engine.startedAt)}`
    : st.schedule.nextRunAt
      ? `next run ${until(st.schedule.nextRunAt)} · every ${interval} min`
      : `last success ${ago(st.overview.lastSuccessAt)}`;

  $('btn-run').disabled = st.engine.running || st.config.missing.length > 0;
  $('btn-stop').hidden = !st.engine.running;
  $('btn-stop').disabled = Boolean(st.engine.stopRequested);
  $('btn-stop').textContent = st.engine.stopRequested ? 'Stopping…' : 'Stop run';
  $('btn-pause').textContent = st.schedule.settings.paused ? 'Resume schedule' : 'Pause schedule';

  const banner = $('banner');
  const notes = [];
  if (st.config.missing.length) notes.push(`Missing environment variable(s): ${st.config.missing.join(', ')}. Set them in Railway and redeploy.`);
  if (st.schedulerError) notes.push(`Scheduler error: ${st.schedulerError}`);
  const lastRun = st.runs[0];
  if (lastRun && lastRun.status === 'failed' && !st.engine.running) notes.push(`Last run #${lastRun.id} failed: ${lastRun.error || 'see event log'}`);
  banner.hidden = notes.length === 0;
  banner.className = `banner${lastRun?.status === 'failed' || st.schedulerError ? ' bad' : ''}`;
  banner.textContent = notes.join('  ·  ');

  const o = st.overview;
  $('k-published').textContent = num(o.last24h.published);
  $('k-rejected').textContent = num(o.last24h.rejected);
  $('k-failed').textContent = num(o.last24h.failed);
  $('k-tavily').textContent = num(o.last24h.tavily_calls);
  $('k-llm').textContent = num(o.last24h.llm_calls);
  $('k-tokens').textContent = num(Number(o.last24h.prompt_tokens) + Number(o.last24h.completion_tokens));
  $('k-live').textContent = num(o.totals.published);
}

$('btn-run').addEventListener('click', async () => {
  try {
    const { runId } = await api('run/start', { method: 'POST', body: {} });
    S.selectedRun = runId;
    S.lastEventId = 0;
    S.events = [];
    await refresh();
  } catch (err) { alert(err.message); }
});

$('btn-stop').addEventListener('click', async () => {
  await api('run/stop', { method: 'POST', body: {} }).catch((err) => alert(err.message));
  refresh();
});

$('btn-pause').addEventListener('click', async () => {
  const paused = !S.state.schedule.settings.paused;
  await api('settings', { method: 'POST', body: { paused } }).catch((err) => alert(err.message));
  refresh();
});

// ---------------------------------------------------------- run history
function renderRuns(runs) {
  const tbody = $('runs-table').querySelector('tbody');
  tbody.replaceChildren(...runs.map((r) => h('tr', {
    class: `clickable${r.id === S.selectedRun ? ' selected' : ''}`,
    onclick: () => selectRun(r.id)
  },
  h('td', {}, `#${r.id}`),
  h('td', {}, chip(r.status)),
  h('td', {}, r.trigger),
  h('td', { title: new Date(r.started_at).toLocaleString() }, ago(r.started_at)),
  h('td', {}, duration(r)),
  h('td', { class: 'num' }, `${r.topics_done}/${r.topics_total}`),
  h('td', { class: 'num' }, num(r.found)),
  h('td', { class: 'num' }, num(r.fresh)),
  h('td', { class: 'num' }, num(r.published)),
  h('td', { class: 'num' }, num(r.rejected)),
  h('td', { class: 'num' }, num(r.failed)),
  h('td', { class: 'num' }, num(r.prompt_tokens + r.completion_tokens)))));
  if (!runs.length) tbody.replaceChildren(h('tr', {}, h('td', { colspan: 12, class: 'empty' }, 'No runs yet — press “Run now” or wait for the schedule.')));
}

function selectRun(id) {
  S.selectedRun = id;
  S.lastEventId = 0;
  S.events = [];
  renderRuns(S.state.runs);
  loadRun();
}

// ------------------------------------------------------------ run detail
function renderFunnel(run) {
  const max = Math.max(run.found, 1);
  const step = (label, value, cls = '') => h('div', { class: `funnel-step ${cls}` },
    h('b', {}, num(value)), h('span', {}, label), h('i', { style: `width:${Math.round((value / max) * 100)}%` }));
  $('funnel').replaceChildren(
    step('Topics searched', run.topics_done),
    step('Results found', run.found),
    step('New (deduped)', run.fresh),
    step('Written', run.generated),
    step('Published', run.published, 'ok'),
    step('Rejected', run.rejected),
    step('Failed', run.failed, run.failed ? 'bad' : '')
  );
  // Topics funnel step should scale on topics_total, not found.
  $('funnel').firstChild.querySelector('i').style.width = `${Math.round((run.topics_done / Math.max(run.topics_total, 1)) * 100)}%`;
}

function renderItems(items) {
  const tbody = $('items-table').querySelector('tbody');
  const rows = items.slice().reverse().map((i) => h('tr', {},
    h('td', {}, chip(i.status)),
    h('td', {}, i.stage),
    h('td', { class: 'title' },
      i.article_id ? h('a', { href: `/rendered/infographic_${i.article_id}.dc.html`, target: '_blank', rel: 'noopener' }, i.title || i.url) : (i.title || i.url),
      i.error ? h('span', { class: 'err' }, i.error) : null),
    h('td', { class: 'num' }, i.tokens ? num(i.tokens) : '')));
  tbody.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'Nothing processed yet.'))]));
}

function renderLog() {
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.replaceChildren(...S.events.map((e) => h('li', { class: `lvl-${e.level}` },
    h('span', { class: 't' }, clock(e.at)),
    h('span', { class: 'stage' }, e.stage),
    h('span', { class: 'm' }, e.message))));
  if (stick) log.scrollTop = log.scrollHeight;
}

async function loadRun() {
  if (!S.selectedRun) return;
  const id = S.selectedRun;
  const data = await api(`run?id=${id}&after=${S.lastEventId}`);
  if (id !== S.selectedRun) return;
  $('run-title').textContent = `Run #${data.run.id}`;
  $('run-meta').replaceChildren(chip(data.run.status), ` ${data.run.trigger} · started ${ago(data.run.started_at)} · ${duration(data.run)}`);
  renderFunnel(data.run);
  renderItems(data.items);
  if (data.events.length) {
    S.events = S.events.concat(data.events).slice(-400);
    S.lastEventId = data.events[data.events.length - 1].id;
  }
  renderLog();
}

// -------------------------------------------------------------- refresh
async function refresh() {
  if (S.busy) return;
  S.busy = true;
  try {
    const st = await api('state');
    S.state = st;
    renderTop(st);
    if (!S.selectedRun && st.runs[0]) S.selectedRun = st.runs[0].id;
    renderRuns(st.runs);
    await loadRun();
  } catch (err) {
    if (err.message !== 'Signed out') {
      $('banner').hidden = false;
      $('banner').className = 'banner bad';
      $('banner').textContent = `Dashboard error: ${err.message}`;
    }
  } finally {
    S.busy = false;
  }
}

function schedulePoll() {
  const running = S.state?.engine.running;
  setTimeout(async () => {
    if (!document.hidden && !$('app').hidden) await refresh();
    schedulePoll();
  }, running ? 2000 : 6000);
}

// ----------------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  S.tab = btn.dataset.tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-body').forEach((d) => { d.hidden = d.id !== `tab-${S.tab}`; });
  loadTab();
}));

async function loadTab() {
  const body = $(`tab-${S.tab}`);
  try {
    if (S.tab === 'topics') await renderTopics(body);
    else if (S.tab === 'settings') await renderSettings(body);
    else if (S.tab === 'failures') await renderFailures(body);
    else if (S.tab === 'articles') await renderArticles(body);
    else await renderHealth(body);
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

async function renderTopics(body) {
  const { topics } = await api('topics');
  const f = {
    query: h('input', { placeholder: 'Search query, e.g. Malaysia solar tariff news', 'aria-label': 'Query' }),
    region: h('input', { placeholder: 'Region label', value: 'World', 'aria-label': 'Region' }),
    country: h('input', { placeholder: 'CC', maxlength: 2, 'aria-label': 'Country code' }),
    section: h('input', { placeholder: 'section', value: 'business', 'aria-label': 'Section' })
  };
  const add = h('div', { class: 'topic-add' }, f.query, f.region, f.country, f.section,
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api('topics', { method: 'POST', body: { query: f.query.value, region: f.region.value, country: f.country.value, section: f.section.value } });
          renderTopics(body);
        } catch (err) { alert(err.message); }
      }
    }, 'Add topic'));

  const rows = topics.map((t) => h('tr', {},
    h('td', {}, h('input', {
      type: 'checkbox', checked: t.enabled, 'aria-label': `Enable ${t.query}`,
      onchange: (e) => api('topics', { method: 'POST', body: { id: t.id, enabled: e.target.checked } }).catch((err) => alert(err.message))
    })),
    h('td', { class: 'title' }, t.query),
    h('td', {}, `${t.region}${t.country ? ` · ${t.country}` : ''}`),
    h('td', {}, t.section),
    h('td', {}, t.last_run_at ? ago(t.last_run_at) : 'never'),
    h('td', { class: 'num' }, t.last_found == null ? '–' : `${t.last_new}/${t.last_found}`),
    h('td', {}, h('button', {
      class: 'btn small danger',
      onclick: async () => {
        if (!confirm(`Delete topic "${t.query}"?`)) return;
        await api('topics', { method: 'POST', body: { id: t.id, delete: true } });
        renderTopics(body);
      }
    }, 'Delete'))));

  body.replaceChildren(
    add,
    h('p', { class: 'muted' }, 'Each run searches the least-recently-searched enabled topics first. “New/found” is the last run’s yield.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'On'), h('th', {}, 'Query'), h('th', {}, 'Region'), h('th', {}, 'Section'), h('th', {}, 'Last run'), h('th', { class: 'num' }, 'New/found'), h('th', {}))),
      h('tbody', {}, rows))));
}

const SETTING_FIELDS = [
  ['intervalMinutes', 'Run every (minutes)', 'Scheduled cadence. Min 5.'],
  ['topicsPerRun', 'Topics per run', 'Tavily searches per run (1 credit each).'],
  ['resultsPerTopic', 'Results per topic', 'Max articles Tavily returns per search.'],
  ['searchDays', 'Look-back (days)', 'Only news from the last N days.'],
  ['maxArticlesPerRun', 'Max articles per run', 'Cap on LLM write calls per run.'],
  ['concurrency', 'Parallel writers', 'Simultaneous LLM calls.'],
  ['minSourceChars', 'Min source length (chars)', 'Thinner pages are skipped.'],
  ['maxTokensPerRun', 'Token budget per run', 'Stops starting new articles once this many tokens are spent.'],
  ['failureBreaker', 'Stop after N model errors in a row', 'Cost guard: pauses the run instead of hammering a struggling model.']
];

async function renderSettings(body) {
  const { settings } = await api('settings');
  const inputs = {};
  const fields = SETTING_FIELDS.map(([key, label, help]) => {
    inputs[key] = h('input', { type: 'number', value: settings[key], id: `s-${key}` });
    return h('div', { class: 'field' }, h('label', { for: `s-${key}` }, label), inputs[key], h('small', {}, help));
  });
  const status = h('span', { class: 'muted' });
  body.replaceChildren(
    h('div', { class: 'form-grid' }, fields),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const patch = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]));
          try {
            await api('settings', { method: 'POST', body: patch });
            status.textContent = 'Saved.';
            refresh();
          } catch (err) { status.textContent = err.message; }
        }
      }, 'Save settings'),
      status));
}

async function renderFailures(body) {
  const { items } = await api('failures');
  if (!items.length) return body.replaceChildren(h('p', { class: 'empty' }, 'No failed articles on record.'));
  body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Run'), h('th', {}, 'Stage'), h('th', {}, 'Article / error'))),
    h('tbody', {}, items.map((i) => h('tr', {},
      h('td', {}, ago(i.updated_at)), h('td', {}, `#${i.run_id}`), h('td', {}, i.stage),
      h('td', { class: 'title' }, h('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer' }, i.title || i.url), h('span', { class: 'err' }, i.error || ''))))))));
}

async function renderArticles(body) {
  const { articles } = await api('articles');
  if (!articles.length) return body.replaceChildren(h('p', { class: 'empty' }, 'No articles in the database yet.'));
  body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'State'), h('th', {}, 'Title'), h('th', {}, 'Source'), h('th', {}, 'Region'), h('th', {}, 'Fetched'))),
    h('tbody', {}, articles.map((a) => h('tr', {},
      h('td', {}, `#${a.id}`),
      h('td', {}, chip(a.status === 'enriched' ? 'published' : (a.status || 'pending'))),
      h('td', { class: 'title' }, a.status === 'enriched'
        ? h('a', { href: `/rendered/infographic_${a.id}.dc.html`, target: '_blank', rel: 'noopener' }, a.title)
        : a.title),
      h('td', {}, a.source || ''),
      h('td', {}, [a.country, a.section].filter(Boolean).join(' · ')),
      h('td', {}, ago(a.fetched_at))))))));
}

async function renderHealth(body) {
  const rows = {
    tavily: h('span', { class: 'muted' }, 'not tested'),
    llm: h('span', { class: 'muted' }, 'not tested'),
    schema: h('span', { class: 'muted' }, 'not tested')
  };
  const cfg = S.state.config;
  const test = (target) => async () => {
    rows[target].textContent = 'testing…';
    try {
      const out = (await api('test', { method: 'POST', body: { target } }))[target];
      rows[target].textContent = out.ok
        ? `OK${out.latencyMs ? ` · ${out.latencyMs} ms` : ''}${out.model ? ` · ${out.model}` : ''}${out.columns ? ` · ${out.columns.length} columns` : ''}`
        : `FAILED: ${out.error || (out.blockers ? `enrichment table needs: ${out.blockers.join(', ')}` : 'unknown')}`;
      rows[target].className = out.ok ? 'chip done' : 'chip failed';
    } catch (err) { rows[target].textContent = err.message; }
  };
  const row = (label, detail, key) => h('div', { class: 'health-row' },
    h('div', {}, h('b', {}, label), h('div', { class: 'muted' }, detail)),
    h('div', { class: 'row', style: 'margin:0' }, rows[key], h('button', { class: 'btn small', onclick: test(key) }, 'Test')));
  body.replaceChildren(h('div', { class: 'health' },
    row('Tavily search', cfg.tavilyConfigured ? 'API key set (1 credit per test)' : 'TAVILY_API_KEY missing', 'tavily'),
    row('LLM router', `${cfg.llmModel} @ ${cfg.llmBaseUrl}${cfg.llmConfigured ? '' : ' — LLM_API_KEY missing'}`, 'llm'),
    row('Database schema', 'article_enrichments writable by the engine', 'schema')));
}

// ----------------------------------------------------------------- boot
(async function boot() {
  try {
    await api('state');
    $('app').hidden = false;
    await refresh();
    loadTab();
    schedulePoll();
  } catch (err) {
    if (err.message !== 'Signed out') {
      $('app').hidden = false;
      $('banner').hidden = false;
      $('banner').className = 'banner bad';
      $('banner').textContent = `Dashboard error: ${err.message}`;
    }
    schedulePoll();
  }
})();
