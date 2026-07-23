const root = document.documentElement;
const newsRoot = document.getElementById('news-root');
const searchInput = document.getElementById('news-search');
const countryFilter = document.getElementById('country-filter');
const loadStatus = document.getElementById('load-status');
const editionCount = document.getElementById('edition-count');
const articleById = new Map();

const tagTrigger = document.getElementById('tag-trigger');
const tagTriggerText = document.getElementById('tag-trigger-text');
const tagModalBackdrop = document.getElementById('tag-modal-backdrop');
const tagModalClose = document.getElementById('tag-modal-close');
const tagModalSearch = document.getElementById('tag-modal-search');
const tagSelectAll = document.getElementById('tag-select-all');
const tagClearAll = document.getElementById('tag-clear-all');
const tagModalList = document.getElementById('tag-modal-list');
const tagModalDone = document.getElementById('tag-modal-done');

const articleModalBackdrop = document.getElementById('article-modal-backdrop');
const articleModalClose = document.getElementById('article-modal-close');
const articleModalMeta = document.getElementById('article-modal-meta');
const articleModalBody = document.getElementById('article-modal-body');


function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = `; expires=${date.toUTCString()}`;
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}${expires}; path=/; SameSite=Lax`;
  try {
    localStorage.setItem(name, JSON.stringify(value));
  } catch {}
}

function getCookie(name) {
  const nameEQ = `${name}=`;
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) {
      try {
        return JSON.parse(decodeURIComponent(c.substring(nameEQ.length, c.length)));
      } catch {
        return null;
      }
    }
  }
  try {
    const local = localStorage.getItem(name);
    return local ? JSON.parse(local) : null;
  } catch {
    return null;
  }
}

const copy = {
  en: {
    desk: 'by Eternalgy',
    edition: 'Latest completed renders',
    footer: 'Collected locally and arranged by region',
    search: 'Search headlines, sources, regions',
    countryFilter: 'Country',
    tagFilter: 'Tag',
    allCountries: 'All countries',
    allTags: 'All tags',
    loading: 'Loading the latest collected edition...',
    loadError: 'The collected news feed could not be loaded.',
    empty: 'No completed article renders are available yet.',
    noMatch: 'No stories match these filters.',
    topStory: 'Top story',
    news: 'News',
    stories: 'stories',
    sourceLink: 'View original source ↗',
    unknownDate: 'Publication time unavailable',
    selectTags: 'Select Tags',
    searchTags: 'Search tags...',
    selectAll: 'Select all',
    clearAll: 'Clear all',
    done: 'Done',
    tagsSelected: '{n} tags selected',
    allTagsSelected: 'All tags selected',
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
    desk: '由 Eternalgy 出品',
    edition: '最新完成渲染的报道',
    footer: '本地采集，按地区编排',
    search: '搜索标题、来源或地区',
    countryFilter: '国家',
    tagFilter: '标签',
    allCountries: '所有国家',
    allTags: '所有标签',
    loading: '正在载入最新采集版面...',
    loadError: '无法载入已采集的新闻。',
    empty: '目前没有已完成渲染的报道。',
    noMatch: '没有符合筛选条件的新闻。',
    topStory: '头条',
    news: '新闻',
    stories: '篇报道',
    sourceLink: '查看原始来源 ↗',
    unknownDate: '发布时间不详',
    selectTags: '选择标签',
    searchTags: '搜索标签...',
    selectAll: '全选',
    clearAll: '清空',
    done: '完成',
    tagsSelected: '已选择 {n} 个标签',
    allTagsSelected: '已选择所有标签',
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

const regionOrder = ['Malaysia', 'ASEAN', 'China', 'Japan & South Korea', 'Europe & US', 'World'];
const aseanCountries = new Set(['ID', 'SG', 'TH', 'VN', 'PH', 'BN', 'KH', 'LA', 'MM', 'TL']);
const chinaCountries = new Set(['CN', 'HK', 'MO', 'TW']);
const northeastAsiaCountries = new Set(['JP', 'KR', 'KP']);
const westernCountries = new Set([
  'US', 'CA', 'MX', 'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU',
  'CH', 'AT', 'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'UA', 'MD', 'AL', 'BA', 'ME', 'MK', 'RS'
]);

const savedCountries = getCookie('meridian-countries');
const savedTags = getCookie('meridian-tags');

const state = {
  articles: [],
  query: '',
  countries: Array.isArray(savedCountries) ? savedCountries : (typeof savedCountries === 'string' && savedCountries ? [savedCountries] : []),
  tags: Array.isArray(savedTags) ? savedTags : (typeof savedTags === 'string' && savedTags ? [savedTags] : []),
  language: localStorage.getItem('meridian-language') === 'cn' ? 'cn' : 'en'
};

function currentCopy() {
  return copy[state.language];
}

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

function locale() {
  return state.language === 'cn' ? 'zh-CN' : 'en-GB';
}

function formatMinutesAgo(value, fallback = '') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;

  const minutesAgo = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  return new Intl.RelativeTimeFormat(locale(), {
    numeric: 'always',
    style: 'narrow'
  }).format(-minutesAgo, 'minute');
}

function countryName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale()], { type: 'region' }).of(String(code).toUpperCase()) || code;
  } catch {
    return code;
  }
}

function articleTags(article) {
  if (!Array.isArray(article.tags)) return [];
  return article.tags.map((tag) => String(tag || '').trim()).filter(Boolean);
}

function tagLabel(tag) {
  const label = String(tag || '').replace(/-/g, ' ').trim();
  return label ? label.charAt(0).toLocaleUpperCase(locale()) + label.slice(1) : '';
}

function replaceFilterOptions(select, allLabel, values, labelForValue) {
  const options = [new Option(allLabel, '')];
  values.forEach((value) => options.push(new Option(labelForValue(value), value)));
  select.replaceChildren(...options);
}

function renderCountryButtons(countries) {
  const allButton = makeElement('button', 'country-toggle', currentCopy().allCountries);
  allButton.type = 'button';
  allButton.dataset.country = '';
  allButton.setAttribute('aria-pressed', String(state.countries.length === 0));

  const countryButtons = countries.map((country) => {
    const label = countryName(country);
    const button = makeElement('button', 'country-toggle', label);
    button.type = 'button';
    button.dataset.country = country;
    button.setAttribute('aria-pressed', String(state.countries.includes(country)));
    return button;
  });

  countryFilter.replaceChildren(allButton, ...countryButtons);
}

let tagModalSearchQuery = '';

function updateTagTriggerText() {
  if (!tagTriggerText) return;
  if (state.tags.length === 0) {
    tagTriggerText.textContent = currentCopy().allTags;
  } else if (state.tags.length === 1) {
    tagTriggerText.textContent = tagLabel(state.tags[0]);
  } else {
    tagTriggerText.textContent = `${currentCopy().tagFilter} (${state.tags.length})`;
  }
}

function updateTagModalFooter() {
  if (!tagModalCount) return;
  if (state.tags.length === 0) {
    tagModalCount.textContent = currentCopy().allTagsSelected;
  } else {
    tagModalCount.textContent = currentCopy().tagsSelected.replace('{n}', state.tags.length);
  }
}

function allAvailableTags() {
  return [...new Set(state.articles.flatMap(articleTags))]
    .sort((a, b) => tagLabel(a).localeCompare(tagLabel(b), locale()));
}

function renderTagModalList() {
  if (!tagModalList) return;
  const tags = allAvailableTags();
  const filtered = tags.filter((tag) => {
    if (!tagModalSearchQuery) return true;
    const label = tagLabel(tag).toLocaleLowerCase(locale());
    const raw = tag.toLocaleLowerCase(locale());
    return label.includes(tagModalSearchQuery) || raw.includes(tagModalSearchQuery);
  });

  if (!filtered.length) {
    tagModalList.replaceChildren(makeElement('p', 'modal-empty-state', currentCopy().noMatch));
    updateTagModalFooter();
    return;
  }

  const chips = filtered.map((tag) => {
    const chip = makeElement('button', 'tag-chip', tagLabel(tag));
    chip.type = 'button';
    chip.dataset.tag = tag;
    chip.setAttribute('aria-pressed', String(state.tags.includes(tag)));
    return chip;
  });

  tagModalList.replaceChildren(...chips);
  updateTagModalFooter();
}

function openTagModal() {
  tagModalSearchQuery = '';
  if (tagModalSearch) tagModalSearch.value = '';
  renderTagModalList();
  if (tagModalBackdrop) tagModalBackdrop.removeAttribute('hidden');
  if (tagTrigger) tagTrigger.setAttribute('aria-expanded', 'true');
  if (tagModalSearch) tagModalSearch.focus();
}

function closeTagModal() {
  if (tagModalBackdrop) tagModalBackdrop.setAttribute('hidden', '');
  if (tagTrigger) tagTrigger.setAttribute('aria-expanded', 'false');
}

function renderFilterOptions() {
  const countries = [...new Set(state.articles.map((article) => String(article.country || '').toUpperCase()).filter(Boolean))]
    .sort((a, b) => countryName(a).localeCompare(countryName(b), locale()));

  renderCountryButtons(countries);
  updateTagTriggerText();
}

// Enriched fields arrive as { en, zh } pairs. Pick the current language (the UI
// labels Chinese 'cn'; the enrichment labels it 'zh'), falling back to whichever
// is present. The raw source title/body are never sent to the browser.
function pickText(pair) {
  if (!pair || typeof pair !== 'object') return '';
  const key = state.language === 'cn' ? 'zh' : 'en';
  return String(pair[key] || pair.en || pair.zh || '').trim();
}

function articleSummary(article) {
  const candidate = pickText(article.summary).replace(/\s+/g, ' ').trim();
  if (candidate.length <= 230) return candidate;
  return `${candidate.slice(0, 227).trimEnd()}...`;
}

function articleSearchText(article) {
  const t = article.displayTitle || {};
  const s = article.summary || {};
  return [
    t.en,
    t.zh,
    s.en,
    s.zh,
    article.source,
    article.section,
    articleTags(article).join(' '),
    article.country,
    countryName(article.country),
    regionFor(article.country),
    article.author
  ].filter(Boolean).join(' ').toLocaleLowerCase(locale());
}

function createTag(text, signal = false) {
  const tag = makeElement('span', `story-tag${signal ? ' signal' : ''}`, text);
  return tag;
}

function createMeta(article) {
  const meta = makeElement('div', 'story-meta');
  const values = [
    article.source,
    countryName(article.country),
    formatMinutesAgo(article.published_at, currentCopy().unknownDate)
  ].filter(Boolean);

  values.forEach((value) => meta.append(makeElement('span', '', value)));
  return meta;
}

function createStory(article, isTopStory = false) {
  const wrapper = makeElement('article', isTopStory ? 'top-story' : 'story-item');
  const button = makeElement('button', 'story-button');
  button.type = 'button';
  button.dataset.articleId = article.id;
  button.setAttribute('aria-label', pickText(article.displayTitle));

  const tags = makeElement('div', 'story-tags');
  if (isTopStory) tags.append(createTag(currentCopy().topStory, true));
  const topicTags = articleTags(article);
  topicTags.slice(0, 4).forEach((tag) => tags.append(createTag(tagLabel(tag))));
  if (tags.children.length === 0) {
    tags.append(createTag(currentCopy().news));
  }
  button.append(tags);

  button.append(makeElement(isTopStory ? 'h2' : 'h3', '', pickText(article.displayTitle)));
  if (isTopStory) button.append(makeElement('p', 'story-summary', articleSummary(article)));
  button.append(createMeta(article));
  wrapper.append(button);
  return wrapper;
}

function createRegionSection(region, articles, index) {
  const section = makeElement('section', 'region-section');
  const heading = makeElement('h2', 'section-label');
  heading.append(makeElement('span', 'section-number', String(index + 1).padStart(2, '0')));
  heading.append(makeElement('span', '', currentCopy().regions[region] || region));
  section.append(heading);

  const list = makeElement('div', 'story-list');
  articles.forEach((article) => list.append(createStory(article)));
  section.append(list);
  return section;
}

function filteredArticles() {
  const query = state.query.trim().toLocaleLowerCase(locale());
  return state.articles.filter((article) => {
    if (state.countries.length > 0) {
      const artCountry = String(article.country || '').toUpperCase();
      if (!state.countries.includes(artCountry)) return false;
    }
    if (state.tags.length > 0) {
      const aTags = articleTags(article);
      const matchesAny = state.tags.some((t) => aTags.includes(t));
      if (!matchesAny) return false;
    }
    return !query || articleSearchText(article).includes(query);
  });
}

function renderNews() {
  const articles = filteredArticles();
  newsRoot.replaceChildren();

  if (!articles.length) {
    newsRoot.append(makeElement('p', 'empty-state', state.articles.length ? currentCopy().noMatch : currentCopy().empty));
    editionCount.textContent = state.articles.length ? `0 ${currentCopy().stories}` : '';
    return;
  }

  editionCount.textContent = `${articles.length} ${currentCopy().stories}`;
  newsRoot.append(createStory(articles[0], true));

  const grouped = new Map(regionOrder.map((region) => [region, []]));
  articles.slice(1).forEach((article) => grouped.get(regionFor(article.country)).push(article));

  let sectionIndex = 0;
  regionOrder.forEach((region) => {
    const regionArticles = grouped.get(region);
    if (!regionArticles.length) return;
    newsRoot.append(createRegionSection(region, regionArticles, sectionIndex));
    sectionIndex += 1;
  });
}

function openArticle(article) {
  if (!article) return;

  if (articleModalMeta) {
    articleModalMeta.replaceChildren();
    const tagsDiv = makeElement('div', 'story-tags');
    const topicTags = articleTags(article);
    topicTags.forEach((tag) => tagsDiv.append(createTag(tagLabel(tag))));
    if (tagsDiv.children.length === 0) tagsDiv.append(createTag(currentCopy().news));
    articleModalMeta.append(tagsDiv);
  }

  if (articleModalBody) {
    articleModalBody.replaceChildren();

    const titleEn = article.displayTitle?.en || '';
    const titleZh = article.displayTitle?.zh || '';

    const titleGroup = makeElement('div', 'modal-title-group');
    if (state.language === 'cn') {
      if (titleZh) titleGroup.append(makeElement('h2', 'modal-title-primary', titleZh));
      if (titleEn) titleGroup.append(makeElement('h3', 'modal-title-secondary', titleEn));
    } else {
      if (titleEn) titleGroup.append(makeElement('h2', 'modal-title-primary', titleEn));
      if (titleZh) titleGroup.append(makeElement('h3', 'modal-title-secondary', titleZh));
    }
    articleModalBody.append(titleGroup);

    const meta = makeElement('div', 'story-meta modal-story-meta');
    [article.source, countryName(article.country), formatMinutesAgo(article.published_at, currentCopy().unknownDate)]
      .filter(Boolean)
      .forEach((val) => meta.append(makeElement('span', '', val)));
    articleModalBody.append(meta);

    const summaryEn = article.summary?.en || '';
    const summaryZh = article.summary?.zh || '';

    const summarySec = makeElement('div', 'modal-section');
    summarySec.append(makeElement('h4', 'modal-section-title', state.language === 'cn' ? '核心摘要' : 'Executive Summary'));

    if (state.language === 'cn') {
      if (summaryZh) summarySec.append(makeElement('p', 'modal-summary-text', summaryZh));
      if (summaryEn) summarySec.append(makeElement('p', 'modal-summary-subtext', summaryEn));
    } else {
      if (summaryEn) summarySec.append(makeElement('p', 'modal-summary-text', summaryEn));
      if (summaryZh) summarySec.append(makeElement('p', 'modal-summary-subtext', summaryZh));
    }
    articleModalBody.append(summarySec);

    if (Array.isArray(article.keyFacts) && article.keyFacts.length > 0) {
      const factsSec = makeElement('div', 'modal-section');
      factsSec.append(makeElement('h4', 'modal-section-title', state.language === 'cn' ? '关键要点' : 'Key Takeaways'));
      const ul = makeElement('ul', 'modal-facts-list');
      article.keyFacts.forEach((fact) => {
        const li = makeElement('li', 'modal-fact-item');
        const mainText = pickText(fact);
        const subText = state.language === 'cn' ? (fact.en || '') : (fact.zh || '');
        li.append(makeElement('div', 'modal-fact-main', mainText));
        if (subText && subText !== mainText) {
          li.append(makeElement('div', 'modal-fact-sub', subText));
        }
        ul.append(li);
      });
      factsSec.append(ul);
      articleModalBody.append(factsSec);
    }

    if (article.url) {
      const linkSec = makeElement('div', 'modal-link-section');
      const a = makeElement('a', 'source-link-button', currentCopy().sourceLink);
      a.href = article.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      linkSec.append(a);
      articleModalBody.append(linkSec);
    }
  }

  if (articleModalBackdrop) articleModalBackdrop.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}

function closeArticleModal() {
  if (articleModalBackdrop) articleModalBackdrop.setAttribute('hidden', '');
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
    element.textContent = currentCopy()[element.dataset.copy];
  });
  searchInput.placeholder = currentCopy().search;
  document.getElementById('edition-date').textContent = new Intl.DateTimeFormat(locale(), { dateStyle: 'full' }).format(new Date());
  renderFilterOptions();
  renderNews();
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

async function loadNews() {
  loadStatus.textContent = currentCopy().loading;
  try {
    const response = await fetch('/api/news');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.articles = (payload.articles || [])
      .filter((article) => article.publication_status === 'rendered')
      .map((article, index) => ({
        ...article,
        id: `article-${index}`
      }));
    articleById.clear();
    state.articles.forEach((article) => articleById.set(article.id, article));
    loadStatus.textContent = '';
    renderFilterOptions();
    renderNews();
  } catch (error) {
    console.error(error);
    state.articles = [];
    loadStatus.textContent = currentCopy().loadError;
    renderNews();
  }
}

newsRoot.addEventListener('click', (event) => {
  const button = event.target.closest('[data-article-id]');
  if (!button) return;
  const article = articleById.get(button.dataset.articleId);
  if (article) openArticle(article);
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  renderNews();
});

countryFilter.addEventListener('click', (event) => {
  const button = event.target.closest('[data-country]');
  if (!button) return;
  const country = button.dataset.country;
  if (!country) {
    state.countries = [];
  } else {
    if (state.countries.includes(country)) {
      state.countries = state.countries.filter((c) => c !== country);
    } else {
      state.countries = [...state.countries, country];
    }
  }
  setCookie('meridian-countries', state.countries);
  renderFilterOptions();
  renderNews();
});

if (tagTrigger) {
  tagTrigger.addEventListener('click', openTagModal);
}
if (tagModalClose) {
  tagModalClose.addEventListener('click', closeTagModal);
}
if (tagModalDone) {
  tagModalDone.addEventListener('click', closeTagModal);
}
if (tagModalBackdrop) {
  tagModalBackdrop.addEventListener('click', (event) => {
    if (event.target === tagModalBackdrop) closeTagModal();
  });
}
if (articleModalClose) {
  articleModalClose.addEventListener('click', closeArticleModal);
}
if (articleModalBackdrop) {
  articleModalBackdrop.addEventListener('click', (event) => {
    if (event.target === articleModalBackdrop) closeArticleModal();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (articleModalBackdrop && !articleModalBackdrop.hasAttribute('hidden')) {
      closeArticleModal();
    } else if (tagModalBackdrop && !tagModalBackdrop.hasAttribute('hidden')) {
      closeTagModal();
    }
  }
});


if (tagModalSearch) {
  tagModalSearch.addEventListener('input', () => {
    tagModalSearchQuery = tagModalSearch.value.trim().toLocaleLowerCase(locale());
    renderTagModalList();
  });
}

if (tagSelectAll) {
  tagSelectAll.addEventListener('click', () => {
    const visibleTags = allAvailableTags().filter((tag) => {
      if (!tagModalSearchQuery) return true;
      const label = tagLabel(tag).toLocaleLowerCase(locale());
      const raw = tag.toLocaleLowerCase(locale());
      return label.includes(tagModalSearchQuery) || raw.includes(tagModalSearchQuery);
    });
    const next = new Set([...state.tags, ...visibleTags]);
    state.tags = [...next];
    setCookie('meridian-tags', state.tags);
    updateTagTriggerText();
    renderTagModalList();
    renderNews();
  });
}

if (tagClearAll) {
  tagClearAll.addEventListener('click', () => {
    state.tags = [];
    setCookie('meridian-tags', state.tags);
    updateTagTriggerText();
    renderTagModalList();
    renderNews();
  });
}

if (tagModalList) {
  tagModalList.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tag]');
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (state.tags.includes(tag)) {
      state.tags = state.tags.filter((t) => t !== tag);
    } else {
      state.tags = [...state.tags, tag];
    }
    setCookie('meridian-tags', state.tags);
    chip.setAttribute('aria-pressed', String(state.tags.includes(tag)));
    updateTagTriggerText();
    updateTagModalFooter();
    renderNews();
  });
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
loadNews();

