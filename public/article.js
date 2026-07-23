const root = document.documentElement;
const articleRoot = document.getElementById('article-root');

const aseanCountries = new Set(['ID', 'SG', 'TH', 'VN', 'PH', 'BN', 'KH', 'LA', 'MM', 'TL']);
const chinaCountries = new Set(['CN', 'HK', 'MO', 'TW']);
const northeastAsiaCountries = new Set(['JP', 'KR', 'KP']);
const westernCountries = new Set([
  'US', 'CA', 'MX', 'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU',
  'CH', 'AT', 'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'UA', 'MD', 'AL', 'BA', 'ME', 'MK', 'RS'
]);

const copy = {
  en: {
    back: 'Back to Front Page',
    summaryTitle: 'Executive Summary',
    factsTitle: 'Key Takeaways & Analysis',
    sourceLink: 'View Original Source ↗',
    unknownDate: 'Publication time unavailable',
    notFound: 'Article not found. It may have been updated or removed.',
    regions: {
      Malaysia: 'Malaysia',
      ASEAN: 'ASEAN',
      China: 'China',
      'Japan & South Korea': 'Japan & South Korea',
      'Europe & US': 'Europe & US',
      World: 'World'
    }
  },
  cn: {
    back: '返回首页',
    summaryTitle: '核心摘要',
    factsTitle: '关键要点与分析',
    sourceLink: '查看原始来源 ↗',
    unknownDate: '发布时间不详',
    notFound: '未找到该报道。报道可能已被更新或移除。',
    regions: {
      Malaysia: '马来西亚',
      ASEAN: '东盟国家',
      China: '中国',
      'Japan & South Korea': '日本与韩国',
      'Europe & US': '欧美',
      World: '世界'
    }
  }
};

const state = {
  article: null,
  language: localStorage.getItem('meridian-language') === 'cn' ? 'cn' : 'en'
};

function currentCopy() {
  return copy[state.language];
}

function locale() {
  return state.language === 'cn' ? 'zh-CN' : 'en-GB';
}

function countryName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale()], { type: 'region' }).of(String(code).toUpperCase()) || code;
  } catch {
    return code;
  }
}

function formatMinutesAgo(value, fallback = '') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const minutesAgo = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'always', style: 'narrow' }).format(-minutesAgo, 'minute');
}

function pickText(pair) {
  if (!pair || typeof pair !== 'object') return '';
  const key = state.language === 'cn' ? 'zh' : 'en';
  return String(pair[key] || pair.en || pair.zh || '').trim();
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function tagLabel(tag) {
  const label = String(tag || '').replace(/-/g, ' ').trim();
  return label ? label.charAt(0).toLocaleUpperCase(locale()) + label.slice(1) : '';
}

function renderArticle() {
  if (!state.article) {
    articleRoot.replaceChildren(makeElement('p', 'empty-state', currentCopy().notFound));
    return;
  }

  const art = state.article;
  document.title = `${pickText(art.displayTitle)} — Eter News`;

  const container = makeElement('article', 'article-container');

  // Tags header
  const tagsDiv = makeElement('div', 'story-tags article-tags');
  const topicTags = Array.isArray(art.tags) ? art.tags : [];
  topicTags.forEach((t) => tagsDiv.append(makeElement('span', 'story-tag', tagLabel(t))));
  container.append(tagsDiv);

  // Title group
  const titleGroup = makeElement('div', 'article-title-group');
  const titleEn = art.displayTitle?.en || '';
  const titleZh = art.displayTitle?.zh || '';

  if (state.language === 'cn') {
    if (titleZh) titleGroup.append(makeElement('h1', 'article-main-title', titleZh));
    if (titleEn) titleGroup.append(makeElement('h2', 'article-sub-title', titleEn));
  } else {
    if (titleEn) titleGroup.append(makeElement('h1', 'article-main-title', titleEn));
    if (titleZh) titleGroup.append(makeElement('h2', 'article-sub-title', titleZh));
  }
  container.append(titleGroup);

  // Meta bar
  const meta = makeElement('div', 'article-meta-bar');
  [
    art.source,
    countryName(art.country),
    formatMinutesAgo(art.published_at, currentCopy().unknownDate),
    art.author
  ].filter(Boolean).forEach((val) => meta.append(makeElement('span', 'meta-item', val)));
  container.append(meta);

  // Executive Summary Card
  const summaryEn = art.summary?.en || '';
  const summaryZh = art.summary?.zh || '';
  if (summaryEn || summaryZh) {
    const summaryCard = makeElement('div', 'article-summary-card');
    summaryCard.append(makeElement('h3', 'card-section-title', currentCopy().summaryTitle));
    
    if (state.language === 'cn') {
      if (summaryZh) summaryCard.append(makeElement('p', 'summary-primary', summaryZh));
      if (summaryEn) summaryCard.append(makeElement('p', 'summary-secondary', summaryEn));
    } else {
      if (summaryEn) summaryCard.append(makeElement('p', 'summary-primary', summaryEn));
      if (summaryZh) summaryCard.append(makeElement('p', 'summary-secondary', summaryZh));
    }
    container.append(summaryCard);
  }

  // Key Facts List
  if (Array.isArray(art.keyFacts) && art.keyFacts.length > 0) {
    const factsCard = makeElement('div', 'article-facts-card');
    factsCard.append(makeElement('h3', 'card-section-title', currentCopy().factsTitle));
    const ul = makeElement('ul', 'article-facts-list');
    art.keyFacts.forEach((fact) => {
      const li = makeElement('li', 'fact-item');
      const mainText = pickText(fact);
      const subText = state.language === 'cn' ? (fact.en || '') : (fact.zh || '');
      li.append(makeElement('div', 'fact-main-text', mainText));
      if (subText && subText !== mainText) {
        li.append(makeElement('div', 'fact-sub-text', subText));
      }
      ul.append(li);
    });
    factsCard.append(ul);
    container.append(factsCard);
  }

  // Source Credit Button
  if (art.url) {
    const sourceBox = makeElement('div', 'article-source-box');
    const a = makeElement('a', 'source-link-button', currentCopy().sourceLink);
    a.href = art.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    sourceBox.append(a);
    container.append(sourceBox);
  }

  articleRoot.replaceChildren(container);
}

function applyLanguage(lang) {
  state.language = lang;
  localStorage.setItem('meridian-language', lang);
  document.cookie = `meridian-language=${lang}; path=/; max-age=31536000; SameSite=Lax`;
  root.dataset.lang = lang;
  root.lang = lang === 'cn' ? 'zh-CN' : 'en';

  document.getElementById('language-en').setAttribute('aria-pressed', String(lang === 'en'));
  document.getElementById('language-cn').setAttribute('aria-pressed', String(lang === 'cn'));
  
  document.querySelectorAll('[data-copy]').forEach((el) => {
    if (currentCopy()[el.dataset.copy]) {
      el.textContent = currentCopy()[el.dataset.copy];
    }
  });

  renderArticle();
}

function applyTheme(theme) {
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  localStorage.setItem('meridian-theme', theme);
  document.cookie = `meridian-theme=${theme}; path=/; max-age=31536000; SameSite=Lax`;
}

function updateProgress() {
  const available = document.documentElement.scrollHeight - window.innerHeight;
  const progress = available > 0 ? Math.min(100, (window.scrollY / available) * 100) : 0;
  document.getElementById('reading-progress').style.width = `${progress}%`;
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const targetUrl = params.get('url') || '';
  const targetId = params.get('id') || '';

  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const articles = payload.articles || [];

    if (targetUrl) {
      state.article = articles.find((a) => a.url === targetUrl) || null;
    } else if (targetId) {
      const idx = parseInt(targetId.replace('article-', ''), 10);
      state.article = Number.isInteger(idx) ? articles[idx] : null;
    }
    if (!state.article && articles.length > 0) {
      state.article = articles[0];
    }
  } catch (err) {
    console.error('Failed to load article:', err);
  }

  renderArticle();
}

document.getElementById('language-en').addEventListener('click', () => applyLanguage('en'));
document.getElementById('language-cn').addEventListener('click', () => applyLanguage('cn'));
document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
});

window.addEventListener('scroll', updateProgress, { passive: true });
window.addEventListener('resize', updateProgress);

const savedTheme = localStorage.getItem('meridian-theme');
applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
applyLanguage(state.language);
updateProgress();
init();
