const root = document.documentElement;
const readerRoot = document.getElementById('reader-root');
const searchInput = document.getElementById('news-search');
const loadStatus = document.getElementById('load-status');
const editionCount = document.getElementById('edition-count');
const overlay = document.getElementById('render-overlay');
const frame = document.getElementById('render-frame');

const copy = {
  en: {
    desk: 'Rendered Editions',
    edition: 'Completed renders, newest first',
    footer: 'Collected locally, arranged by date',
    search: 'Search headlines, sources',
    loading: 'Loading rendered editions...',
    loadError: 'The rendered news feed could not be loaded.',
    empty: 'No rendered articles are available yet.',
    noMatch: 'No stories match this search.',
    stories: 'renders',
    sourceLink: 'Original source ↗',
    openTab: 'Open in new tab ↗',
    unknownDate: 'Publication time unavailable',
    regions: { Malaysia: 'Malaysia', ASEAN: 'ASEAN', China: 'China', 'Japan & South Korea': 'Japan & South Korea', 'Europe & US': 'Europe & US', World: 'World' }
  },
  cn: {
    desk: '已渲染版面',
    edition: '已完成渲染，最新在前',
    footer: '本地采集，按日期编排',
    search: '搜索标题或来源',
    loading: '正在载入已渲染版面...',
    loadError: '无法载入已渲染的新闻。',
    empty: '目前没有已渲染的报道。',
    noMatch: '没有符合搜索条件的新闻。',
    stories: '篇',
    sourceLink: '原始来源 ↗',
    openTab: '在新标签打开 ↗',
    unknownDate: '发布时间不详',
    regions: { Malaysia: '马来西亚', ASEAN: '东盟国家', China: '中国', 'Japan & South Korea': '日本与韩国', 'Europe & US': '欧美', World: '世界' }
  }
};

const aseanCountries = new Set(['ID', 'SG', 'TH', 'VN', 'PH', 'BN', 'KH', 'LA', 'MM', 'TL']);
const chinaCountries = new Set(['CN', 'HK', 'MO', 'TW']);
const northeastAsiaCountries = new Set(['JP', 'KR', 'KP']);
const westernCountries = new Set([
  'US', 'CA', 'MX', 'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU',
  'CH', 'AT', 'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'UA', 'MD', 'AL', 'BA', 'ME', 'MK', 'RS'
]);

const state = {
  articles: [],
  query: '',
  language: localStorage.getItem('meridian-language') === 'cn' ? 'cn' : 'en'
};

function currentCopy() { return copy[state.language]; }
function locale() { return state.language === 'cn' ? 'zh-CN' : 'en-GB'; }

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function regionFor(country) {
  const code = String(country || '').toUpperCase();
  if (code === 'MY') return 'Malaysia';
  if (aseanCountries.has(code)) return 'ASEAN';
  if (chinaCountries.has(code)) return 'China';
  if (northeastAsiaCountries.has(code)) return 'Japan & South Korea';
  if (westernCountries.has(code)) return 'Europe & US';
  return 'World';
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : 'unknown';
}

function formatDayHeading(key) {
  if (key === 'unknown') return currentCopy().unknownDate;
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${key}T00:00:00Z`));
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
}

function countryName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale()], { type: 'region' }).of(String(code).toUpperCase()) || code;
  } catch { return code; }
}

// Enriched fields arrive as { en, zh } pairs. Pick the reader's current language
// (the reader labels Chinese 'cn'; the enrichment labels it 'zh'), falling back
// to whichever language is present. The raw source title/body are never sent.
function pickText(pair) {
  if (!pair || typeof pair !== 'object') return '';
  const key = state.language === 'cn' ? 'zh' : 'en';
  return String(pair[key] || pair.en || pair.zh || '').trim();
}

function summaryText(article) {
  const candidate = pickText(article.summary).replace(/\s+/g, ' ').trim();
  return candidate.length <= 200 ? candidate : `${candidate.slice(0, 197).trimEnd()}...`;
}

function searchText(article) {
  const t = article.displayTitle || {};
  const s = article.summary || {};
  return [t.en, t.zh, s.en, s.zh, article.source, article.section, countryName(article.country), regionFor(article.country)]
    .filter(Boolean).join(' ').toLocaleLowerCase(locale());
}

function filteredArticles() {
  const query = state.query.trim().toLocaleLowerCase(locale());
  if (!query) return state.articles;
  return state.articles.filter((article) => searchText(article).includes(query));
}

function createCard(article) {
  const card = makeElement('button', 'render-card');
  card.type = 'button';
  card.dataset.articleId = article.id;

  card.append(makeElement('span', 'render-time', formatTime(article.published_at)));

  const body = makeElement('div', 'render-body');
  body.append(makeElement('h3', '', pickText(article.displayTitle)));
  const summary = summaryText(article);
  if (summary) body.append(makeElement('p', 'render-summary', summary));

  const meta = makeElement('div', 'render-meta');
  if (article.source) meta.append(makeElement('span', 'render-source', article.source));
  const region = currentCopy().regions[regionFor(article.country)] || regionFor(article.country);
  meta.append(makeElement('span', 'render-region', region));
  if (article.section) meta.append(makeElement('span', '', article.section));
  body.append(meta);

  card.append(body);
  return card;
}

function renderList() {
  const articles = filteredArticles();
  readerRoot.replaceChildren();

  if (!articles.length) {
    readerRoot.append(makeElement('p', 'empty-state', state.articles.length ? currentCopy().noMatch : currentCopy().empty));
    editionCount.textContent = state.articles.length ? `0 ${currentCopy().stories}` : '';
    return;
  }

  editionCount.textContent = `${articles.length} ${currentCopy().stories}`;

  const groups = new Map();
  for (const article of articles) {
    const key = dayKey(article.published_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }

  // Newest day first; 'unknown' sinks to the bottom.
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'unknown') return 1;
    if (b === 'unknown') return -1;
    return b.localeCompare(a);
  });

  for (const key of keys) {
    const group = makeElement('section', 'day-group');
    const heading = makeElement('div', 'day-heading');
    heading.append(makeElement('h2', '', formatDayHeading(key)));
    heading.append(makeElement('span', 'day-count', `${groups.get(key).length} ${currentCopy().stories}`));
    group.append(heading);

    const list = makeElement('div', 'render-list');
    groups.get(key).forEach((article) => list.append(createCard(article)));
    group.append(list);
    readerRoot.append(group);
  }
}

function openRender(article) {
  document.getElementById('render-title').textContent = pickText(article.displayTitle);
  const open = document.getElementById('render-open');
  const source = document.getElementById('render-source');
  const renderUrl = article.render_file ? `/rendered/${encodeURIComponent(article.render_file)}` : '';

  frame.src = renderUrl || 'about:blank';
  open.href = renderUrl || '#';
  open.hidden = !renderUrl;
  source.href = article.url || '#';
  source.hidden = !article.url;

  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeRender() {
  overlay.hidden = true;
  frame.src = 'about:blank';
  document.body.style.overflow = '';
}

function applyLanguage(language) {
  state.language = language;
  localStorage.setItem('meridian-language', language);
  document.cookie = `meridian-language=${language}; path=/; max-age=31536000; SameSite=Lax`;
  root.dataset.lang = language;
  root.lang = language === 'cn' ? 'zh-CN' : 'en';
  document.getElementById('language-en').setAttribute('aria-pressed', String(language === 'en'));
  document.getElementById('language-cn').setAttribute('aria-pressed', String(language === 'cn'));
  document.querySelectorAll('[data-copy]').forEach((element) => {
    const value = currentCopy()[element.dataset.copy];
    if (value) element.textContent = value;
  });
  searchInput.placeholder = currentCopy().search;
  renderList();
}

function applyTheme(theme) {
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  localStorage.setItem('meridian-theme', theme);
  document.cookie = `meridian-theme=${theme}; path=/; max-age=31536000; SameSite=Lax`;
}

async function loadNews() {
  loadStatus.textContent = currentCopy().loading;
  try {
    const response = await fetch('/api/news');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.articles = (payload.articles || [])
      .filter((article) => article.publication_status === 'rendered' && article.render_file)
      .map((article, index) => ({ ...article, id: `article-${index}` }))
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
    loadStatus.textContent = '';
    renderList();
  } catch (error) {
    console.error(error);
    state.articles = [];
    loadStatus.textContent = currentCopy().loadError;
    renderList();
  }
}

readerRoot.addEventListener('click', (event) => {
  const card = event.target.closest('[data-article-id]');
  if (!card) return;
  const article = state.articles.find((entry) => entry.id === card.dataset.articleId);
  if (article) openRender(article);
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  renderList();
});

document.getElementById('language-en').addEventListener('click', () => applyLanguage('en'));
document.getElementById('language-cn').addEventListener('click', () => applyLanguage('cn'));
document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
});
document.getElementById('render-close').addEventListener('click', closeRender);
overlay.addEventListener('click', (event) => { if (event.target === overlay) closeRender(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !overlay.hidden) closeRender(); });

const savedTheme = localStorage.getItem('meridian-theme');
applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
applyLanguage(state.language);
loadNews();
