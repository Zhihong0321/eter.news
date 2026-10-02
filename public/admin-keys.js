// API key manager. All text goes through textContent; secrets are write-only —
// the server only ever returns a masked form.

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
  if (res.status === 401) {
    location.href = '/admin';
    throw new Error('Signed out');
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const TESTS = { tavilyKey: 'tavily', llmKey: 'llm', llmBaseUrl: 'llm', llmModel: 'llm' };

function sourceChip(c) {
  const kind = c.source.startsWith('database') ? 'done' : c.source.startsWith('environment') || c.source === 'default' ? 'running' : 'failed';
  const label = c.source === 'database' ? 'stored in database'
    : c.source === 'environment' ? 'from environment'
    : c.source === 'default' ? 'built-in default'
    : c.source;
  return h('span', { class: `chip ${kind}` }, label);
}

function showBanner(text, bad = false) {
  const b = $('banner');
  b.hidden = !text;
  b.className = `banner${bad ? ' bad' : ''}`;
  b.textContent = text || '';
}

function card(c, reload) {
  const input = h('input', {
    type: c.secret ? 'password' : 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: c.keyCount !== undefined ? 'Paste key(s), separated by commas' : c.secret ? 'Paste a new key to replace' : 'Enter new value',
    id: `in-${c.name}`,
    'aria-label': `New ${c.label}`
  });
  const result = h('span', { class: 'muted' });
  const busy = (btn, on) => { btn.disabled = on; };

  const save = h('button', { class: c.keyCount !== undefined ? 'btn' : 'btn primary' }, c.keyCount !== undefined ? 'Replace all keys' : 'Save to database');
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { result.textContent = 'Nothing to save.'; return; }
    busy(save, true);
    try {
      await api('credentials', { method: 'POST', body: { [c.name]: input.value } });
      input.value = '';
      showBanner('');
      await reload(`${c.label} saved.`);
    } catch (err) {
      result.textContent = err.message;
      busy(save, false);
    }
  });

  const actions = [save];

  if (c.keyCount !== undefined) {
    // Requests rotate round-robin across every key in the pool.
    const add = h('button', { class: 'btn primary' }, 'Add to pool');
    add.addEventListener('click', async () => {
      if (!input.value.trim()) { result.textContent = 'Nothing to add.'; return; }
      busy(add, true);
      try {
        await api('credentials', { method: 'POST', body: { addTavilyKeys: input.value } });
        input.value = '';
        showBanner('');
        await reload(`Keys added to the ${c.label} pool.`);
      } catch (err) {
        result.textContent = err.message;
        busy(add, false);
      }
    });
    actions.unshift(add);
  }

  const target = TESTS[c.name];
  const test = h('button', { class: 'btn' }, 'Test connection');
  test.addEventListener('click', async () => {
    busy(test, true);
    result.textContent = 'testing…';
    try {
      const out = (await api('test', { method: 'POST', body: { target } }))[target];
      result.textContent = out.ok
        ? `OK · ${out.keys ? `${out.keys.length} key(s) working · ` : ''}${out.latencyMs} ms${out.model ? ` · ${out.model}` : ''}`
        : `FAILED: ${out.error}`;
    } catch (err) {
      result.textContent = err.message;
    }
    busy(test, false);
  });
  if (target) actions.push(test);

  if (c.source.startsWith('database') || c.storedUnreadable) {
    const clear = h('button', { class: 'btn danger' }, 'Remove from database');
    clear.addEventListener('click', async () => {
      if (!confirm(`Remove the stored ${c.label}? The engine falls back to the environment variable if one is set.`)) return;
      try {
        await api('credentials', { method: 'POST', body: { clear: c.name } });
        await reload(`${c.label} removed.`);
      } catch (err) { result.textContent = err.message; }
    });
    actions.push(clear);
  }

  return h('article', { class: 'key-card' },
    h('div', { class: 'key-head' },
      h('h3', {}, c.label),
      sourceChip(c)),
    h('p', { class: 'key-current' },
      c.set ? h('code', {}, c.value) : h('span', { class: 'muted' }, 'not set'),
      c.updatedAt && c.source === 'database' ? h('span', { class: 'muted' }, ` · updated ${ago(c.updatedAt)}`) : null),
    c.storedUnreadable ? h('p', { class: 'error' }, 'The stored value cannot be decrypted (SECRETS_KEY / HUB_API_KEY changed). Save it again to fix.') : null,
    h('div', { class: 'field' }, h('label', { for: `in-${c.name}` }, 'New value'), input),
    h('div', { class: 'row' }, actions, result));
}

async function load(message) {
  const { credentials, canEncrypt } = await api('credentials');
  $('enc').textContent = canEncrypt
    ? 'Stored values are encrypted at rest (key derived from the server DATABASE_URL).'
    : '';
  if (!canEncrypt) showBanner('No DATABASE_URL on the server — keys cannot be stored.', true);
  const cards = $('cards');
  cards.replaceChildren(...credentials.map((c) => card(c, load)));
  if (message) {
    const note = h('p', { class: 'chip done', role: 'status' }, message);
    cards.prepend(note);
    setTimeout(() => note.remove(), 4000);
  }
}

$('btn-import').addEventListener('click', async () => {
  try {
    const out = await api('credentials', { method: 'POST', body: { importFromEnv: true } });
    await load(out.imported.length ? `Imported ${out.imported.length} value(s) from the environment.` : 'No environment variables to import.');
  } catch (err) { showBanner(err.message, true); }
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('password', { method: 'POST', body: { current: $('pw-current').value, next: $('pw-next').value } });
    $('pw-current').value = '';
    $('pw-next').value = '';
    $('pw-result').textContent = 'Password changed.';
  } catch (err) {
    $('pw-result').textContent = err.message;
  }
});

load().catch((err) => {
  if (err.message !== 'Signed out') showBanner(err.message, true);
});
