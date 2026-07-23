// Renders an enriched-article packet entry (see editorial-pipeline/src/enrichment-prompt.js
// for the `infographicContent` schema) into a standalone `.dc.html` infographic document.
//
// The visual design, CSS custom properties, and the boot script (language/theme toggle,
// scroll-reveal, animated counters/bars) are carried over verbatim from the hand-built
// reference template (news-tempate.zip / "Masela Infographic v2"). Only the content-bearing
// markup below is generated from data, so any enriched article can be rendered, not just
// the one the reference template was designed around.

const RELATIONSHIP_LABELS = {
  'historical-context': { en: 'Historical context', zh: '历史脉络' },
  comparison: { en: 'Comparison', zh: '对比' },
  cause: { en: 'Cause', zh: '因果关系' },
  consequence: { en: 'Consequence', zh: '影响推演' },
  'stakeholder-impact': { en: 'Stakeholder impact', zh: '利益相关方' },
  contradiction: { en: 'Contradiction', zh: '矛盾之处' },
  'future-signal': { en: 'Future signal', zh: '前瞻信号' }
};

const COUNTRY_NAMES = {
  MY: 'Malaysia', SG: 'Singapore', ID: 'Indonesia', TH: 'Thailand', PH: 'Philippines',
  VN: 'Vietnam', CN: 'China', JP: 'Japan', KR: 'South Korea', US: 'United States',
  GB: 'United Kingdom', HK: 'Hong Kong', TW: 'Taiwan', IN: 'India', AU: 'Australia'
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function pair(value) {
  return { en: value?.en ?? '', zh: value?.zh ?? '' };
}

// Renders a bilingual pair as two spans; CSS on <html data-lang> toggles visibility.
function bi(value) {
  const p = pair(value);
  return `<span class="en">${esc(p.en)}</span><span class="cn">${esc(p.zh)}</span>`;
}

function trimZero(value) {
  return value.replace(/\.0$/, '');
}

function compactEn(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${trimZero((abs / 1e9).toFixed(1))}B`;
  if (abs >= 1e6) return `${sign}${trimZero((abs / 1e6).toFixed(1))}M`;
  if (abs >= 1e3) return `${sign}${abs.toLocaleString('en-US')}`;
  return `${sign}${trimZero(String(abs))}`;
}

function compactZh(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${sign}${trimZero((abs / 1e8).toFixed(1))}亿`;
  if (abs >= 1e4) return `${sign}${trimZero((abs / 1e4).toFixed(1))}万`;
  return `${sign}${abs.toLocaleString('en-US')}`;
}

function formatDate(iso, lang) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (lang === 'zh') return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// A single labeled bar row used by comparison/chart/timeline blocks.
function barRow({ labelPair, valueText, widthPct }) {
  return `
    <div style="display:grid;gap:3px">
      <p style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink2)"><span>${bi(labelPair)}</span><b style="font-family:var(--mf);font-weight:600;color:var(--ink)">${esc(valueText)}</b></p>
      <div style="height:9px;border-radius:5px;background:var(--line);overflow:hidden"><i data-bar style="display:block;height:100%;border-radius:5px;background:var(--gh);width:${widthPct}%"></i></div>
    </div>`;
}

// One metric rendered as its own stat card (used by suggestedPresentation "number").
function metricCard(metric) {
  if (metric.value === null || metric.value === undefined) return '';
  const enNum = compactEn(metric.value);
  const zhNum = compactZh(metric.value);
  const unit = pair(metric.unit);
  const period = pair(metric.period);
  let compareHtml = '';
  if (typeof metric.comparisonValue === 'number') {
    const max = Math.max(Math.abs(metric.value), Math.abs(metric.comparisonValue)) || 1;
    compareHtml = `
      <div style="margin-top:12px;display:grid;gap:8px">
        ${barRow({ labelPair: period, valueText: `${enNum}${unit.en ? ` ${unit.en}` : ''}`, widthPct: Math.round((Math.abs(metric.value) / max) * 100) })}
        ${barRow({ labelPair: pair(metric.comparisonPeriod), valueText: `${compactEn(metric.comparisonValue)}${unit.en ? ` ${unit.en}` : ''}`, widthPct: Math.round((Math.abs(metric.comparisonValue) / max) * 100) })}
      </div>`;
  }
  return `
    <div style="background:var(--paper2);border-radius:14px;padding:16px">
      <p style="font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);margin-bottom:8px">${bi(metric.label)}</p>
      <p style="font-family:var(--df);font-size:38px;line-height:1;color:var(--ink)"><span class="en"><span data-count>${esc(enNum)}</span> <span style="font-family:var(--bf);font-size:13.5px;font-weight:600;color:var(--aink)">${esc(unit.en)}</span></span><span class="cn"><span data-count>${esc(zhNum)}</span><span style="font-family:var(--bf);font-size:13.5px;font-weight:600;color:var(--aink)">${esc(unit.zh)}</span></span></p>
      ${period.en || period.zh ? `<p style="font-family:var(--mf);font-size:11.5px;color:var(--ink3);margin-top:7px">${bi(period)}</p>` : ''}
      ${compareHtml}
    </div>`;
}

// Several metrics normalized into one bar chart (used by "comparison" and "chart").
function multiMetricBars(metrics) {
  const usable = metrics.filter((m) => typeof m.value === 'number');
  if (!usable.length) return '';
  const max = Math.max(...usable.map((m) => Math.abs(m.value))) || 1;
  const head = usable[0];
  const rows = usable.map((m) => barRow({
    labelPair: m.period?.en || m.period?.zh ? m.period : m.label,
    valueText: `${compactEn(m.value)}${m.unit?.en ? ` ${m.unit.en}` : ''}`,
    widthPct: Math.round((Math.abs(m.value) / max) * 100)
  })).join('');
  return `
    <div style="background:var(--paper2);border-radius:14px;padding:16px">
      <p style="font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);margin-bottom:8px">${bi(head.label)}</p>
      <div style="margin-top:2px;display:grid;gap:8px">${rows}</div>
    </div>`;
}

// A compact vertical timeline scoped to one dimension card.
function dimensionTimeline(dimension) {
  const metricsWithPeriod = (dimension.metrics || []).filter((m) => m.period?.en || m.period?.zh);
  const items = metricsWithPeriod.length
    ? metricsWithPeriod.map((m) => ({
        labelPair: m.period,
        textPair: { en: `${compactEn(m.value)}${m.unit?.en ? ` ${m.unit.en}` : ''}`, zh: `${compactZh(m.value)}${m.unit?.zh || ''}` }
      }))
    : (dimension.supportingFacts || []).map((f) => ({ labelPair: null, textPair: f.text }));
  if (!items.length) return '';
  return `
    <ul style="list-style:none;margin-top:16px;display:grid;gap:12px">
      ${items.map((item) => `
        <li style="position:relative;padding-left:18px" style-before="content:'';position:absolute;left:0;top:6px;width:7px;height:7px;border-radius:50%;background:var(--gh)">
          ${item.labelPair ? `<span style="display:block;font-family:var(--mf);font-weight:600;font-size:12px;color:var(--aink);margin-bottom:2px">${bi(item.labelPair)}</span>` : ''}
          <span style="font-size:14.5px;color:var(--ink2)">${bi(item.textPair)}</span>
        </li>`).join('')}
    </ul>`;
}

function dimensionMap(dimension) {
  const metrics = (dimension.metrics || []).filter((m) => typeof m.value === 'number');
  return `
    <div style="background:var(--paper2);border-radius:14px;padding:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:${metrics.length ? '12' : '0'}px">
        <span aria-hidden="true" style="font-size:20px;color:var(--aink)">&#9679;</span>
        <span style="font-family:var(--mf);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)">${bi(dimension.title)}</span>
      </div>
      ${metrics.map((m) => `
        <p style="display:flex;justify-content:space-between;gap:10px;font-size:13.5px;color:var(--ink2);padding:6px 0;border-top:1px dashed var(--line)">
          <span>${bi(m.label)}</span>
          <b style="font-family:var(--mf);font-weight:600;color:var(--ink)"><span class="en">${esc(compactEn(m.value))} ${esc(m.unit?.en || '')}</span><span class="cn">${esc(compactZh(m.value))}${esc(m.unit?.zh || '')}</span></b>
        </p>`).join('')}
    </div>`;
}

function dimensionQuote(dimension, sources) {
  const first = (dimension.supportingFacts || [])[0];
  if (!first) return '';
  const source = sources.find((s) => s.id === first.sourceId);
  return `
    <blockquote style="margin-top:6px;padding:18px 0 4px;border-top:1px dashed var(--line)">
      <span aria-hidden="true" style="font-family:var(--df);font-size:40px;line-height:.4;color:var(--a2);display:block;margin-bottom:8px">&ldquo;</span>
      <p data-cjk="body" style="font-family:var(--if);font-style:italic;font-size:18px;line-height:1.5;color:var(--ink)">${bi(first.text)}</p>
      ${source ? `<footer style="margin-top:10px;font-family:var(--mf);font-size:11.5px;color:var(--ink3)">&mdash; ${esc(source.publisher)}</footer>` : ''}
    </blockquote>`;
}

function supportingFactsList(facts) {
  if (!facts?.length) return '';
  return `
    <ul style="list-style:none;margin-top:16px;border-top:1px dashed var(--line);padding-top:13px">
      ${facts.map((fact) => `<li style="position:relative;padding:0 0 9px 18px;font-size:14.5px;color:var(--ink2)" style-before="content:'';position:absolute;left:2px;top:9px;width:6px;height:2px;background:var(--a2)">${bi(fact.text)}</li>`).join('')}
    </ul>`;
}

function dimensionBody(dimension, sources) {
  const metrics = dimension.metrics || [];
  switch (dimension.suggestedPresentation) {
    case 'number':
      if (!metrics.length) return supportingFactsList(dimension.supportingFacts);
      return `<div style="margin-top:16px;display:grid;gap:12px">${metrics.map(metricCard).join('')}</div>${supportingFactsList(dimension.supportingFacts)}`;
    case 'comparison':
    case 'chart':
      if (!metrics.length) return supportingFactsList(dimension.supportingFacts);
      return `<div style="margin-top:16px">${multiMetricBars(metrics)}</div>${supportingFactsList(dimension.supportingFacts)}`;
    case 'timeline': {
      const usesMetricPeriods = metrics.some((m) => m.period?.en || m.period?.zh);
      const timelineHtml = dimensionTimeline(dimension);
      return usesMetricPeriods ? `${timelineHtml}${supportingFactsList(dimension.supportingFacts)}` : timelineHtml;
    }
    case 'map':
      if (!metrics.length) return supportingFactsList(dimension.supportingFacts);
      return `<div style="margin-top:16px">${dimensionMap(dimension)}</div>${supportingFactsList(dimension.supportingFacts)}`;
    case 'quote': {
      const rest = (dimension.supportingFacts || []).slice(1);
      return `${dimensionQuote(dimension, sources)}${supportingFactsList(rest)}`;
    }
    case 'text':
    default:
      return supportingFactsList(dimension.supportingFacts);
  }
}

function dimensionCard(dimension, index, sources) {
  const badge = RELATIONSHIP_LABELS[dimension.relationship] || { en: dimension.relationship, zh: dimension.relationship };
  return `
  <article data-reveal style="background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);padding:26px 22px 24px;margin-top:26px;position:relative;overflow:hidden">
    <span aria-hidden="true" style="position:absolute;top:-18px;right:6px;font-family:var(--df);font-size:110px;line-height:1;color:var(--paper2);z-index:0;user-select:none">${index + 1}</span>
    <div style="position:relative;z-index:1">
      <span style="font-family:var(--mf);font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--aink);border:1px solid var(--line);border-radius:999px;padding:3px 10px">${bi(badge)}</span>
      <h3 data-cjk="title" style="font-family:var(--df);font-size:22px;font-weight:400;line-height:1.22;letter-spacing:-.01em;margin:14px 0 10px;text-wrap:pretty">${bi(dimension.title)}</h3>
      <p data-cjk="body" style="font-size:16px;color:var(--ink2);text-wrap:pretty">${bi(dimension.insight)}</p>
      ${dimensionBody(dimension, sources)}
    </div>
  </article>`;
}

function heroStatStrip(dimensions) {
  const picked = [];
  for (const dimension of dimensions) {
    const metric = (dimension.metrics || []).find((m) => typeof m.value === 'number');
    if (metric) picked.push(metric);
    if (picked.length === 3) break;
  }
  if (!picked.length) return '';
  return `
    <div style="display:grid;grid-template-columns:repeat(${picked.length},1fr);gap:14px;margin-top:22px;border-top:1px solid var(--line);padding-top:20px">
      ${picked.map((metric, i) => `
        <div ${i > 0 ? 'style="border-left:1px solid var(--line);padding-left:14px"' : ''}>
          <p style="font-family:var(--df);font-size:26px;line-height:1;color:var(--ink)"><span class="en"><span data-count>${esc(compactEn(metric.value))}</span></span><span class="cn"><span data-count>${esc(compactZh(metric.value))}</span></span></p>
          <p style="font-family:var(--mf);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);margin-top:6px">${bi(metric.label)}</p>
        </div>`).join('')}
    </div>`;
}

function timelineSection(events) {
  if (!events?.length) return '';
  return `
<section data-screen-label="Timeline" data-reveal style="margin-top:52px">
  <p style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);display:flex;align-items:center;gap:12px;margin-bottom:18px" style-after="content:'';flex:1;height:1px;background:var(--line)"><span style="color:var(--aink)">03</span><span class="en">Timeline</span><span class="cn">时间线</span></p>
  <ol style="list-style:none;position:relative" style-before="content:'';position:absolute;left:7px;top:8px;bottom:8px;width:2px;background:linear-gradient(180deg,var(--a2),var(--a1),var(--line))">
    ${events.map((event, i) => {
      const last = i === events.length - 1;
      return `
    <li style="position:relative;padding:0 0 ${last ? '4' : '26'}px 34px" style-before="content:'';position:absolute;left:1px;top:5px;width:14px;height:14px;border-radius:50%;background:${last ? 'var(--gh)' : 'var(--paper)'};border:3px solid ${last ? 'var(--a3)' : 'var(--a1)'}">
      <span style="font-family:var(--mf);font-weight:600;font-size:13px;color:var(--aink);letter-spacing:.06em;display:block;margin-bottom:3px">${esc(event.date || '')}</span>
      <span style="font-size:15.5px;color:var(--ink2)">${bi(event.event)}</span>
    </li>`;
    }).join('')}
  </ol>
</section>`;
}

function listSection({ number, titleEn, titleZh, items, ordered = true, renderItem }) {
  if (!items?.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `
<section data-screen-label="${esc(titleEn)}" data-reveal style="margin-top:52px">
  <p style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);display:flex;align-items:center;gap:12px;margin-bottom:20px" style-after="content:'';flex:1;height:1px;background:var(--line)"><span style="color:var(--aink)">${number}</span><span class="en">${esc(titleEn)}</span><span class="cn">${esc(titleZh)}</span></p>
  <${tag} style="list-style:none;display:grid">
    ${items.map(renderItem).join('')}
  </${tag}>
</section>`;
}

function whatToWatchItem(item, index, total) {
  const last = index === total - 1;
  return `<li data-cjk="body" style="position:relative;padding:0 0 ${last ? '0' : '20'}px 46px;font-size:15.5px;color:var(--ink2)" style-before="content:'${String(index + 1).padStart(2, '0')}';position:absolute;left:0;top:1px;font-family:var(--mf);font-weight:600;font-size:15px;color:var(--aink)" ${last ? '' : "style-after=\"content:'';position:absolute;left:0;top:24px;width:26px;height:1px;background:var(--gr)\""}>${bi(item)}</li>`;
}

function uncertaintyItem(item, index, total) {
  const last = index === total - 1;
  return `<li data-cjk="body" style="position:relative;padding:0 0 ${last ? '0' : '15'}px 24px;font-size:15px;color:var(--ink2)" style-before="content:'';position:absolute;left:2px;top:8px;width:8px;height:8px;border:2px solid var(--ink3);transform:rotate(45deg)">${bi(item)}</li>`;
}

function sourcesSection(sources) {
  if (!sources?.length) return '';
  return `
<section data-screen-label="Sources" data-reveal style="margin-top:52px">
  <p style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);display:flex;align-items:center;gap:12px;margin-bottom:6px" style-after="content:'';flex:1;height:1px;background:var(--line)"><span style="color:var(--aink)">06</span><span class="en">Sources</span><span class="cn">信息来源</span></p>
  <ol style="list-style:none">
    ${sources.map((source, i) => `
    <li style="position:relative;padding:12px 0 12px 32px;${i < sources.length - 1 ? 'border-bottom:1px solid var(--line);' : ''}font-size:13.5px;line-height:1.45;color:var(--ink2)" style-before="content:'${i + 1}';position:absolute;left:0;top:13px;font-family:var(--mf);font-weight:600;font-size:12px;color:var(--aink)">
      <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1px solid var(--a2)">${bi(source.title)}</a>
      <small style="display:block;font-family:var(--mf);font-size:11px;color:var(--ink3);margin-top:3px">${esc(source.publisher)}${source.publishedAt ? ` &middot; ${esc(String(source.publishedAt).slice(0, 10))}` : ''}</small>
    </li>`).join('')}
  </ol>
</section>`;
}

function socialShareSection(displayTitle, sourceUrl) {
  const pTitle = pair(displayTitle);
  const enTitle = pTitle.en;
  const url = sourceUrl || '';
  return `
<section data-screen-label="Share" data-reveal style="margin-top:48px;padding:24px 20px;background:var(--paper2);border:1px solid var(--line);border-radius:18px;text-align:center">
  <p style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--aink);margin-bottom:14px">
    <span class="en">Share this analysis</span>
    <span class="cn">分享此深度分析</span>
  </p>
  <div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px">
    <button onclick="shareLink()" style="display:inline-flex;align-items:center;gap:6px;padding:8px 15px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-family:var(--mf);font-size:12px;font-weight:600;cursor:pointer;box-shadow:var(--shadow);transition:transform .15s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='none'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span id="copyLinkTxt"><span class="en">Copy Link</span><span class="cn">复制链接</span></span>
    </button>
    <a href="https://x.com/intent/tweet?text=${encodeURIComponent(enTitle)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-family:var(--mf);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='none'">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      <span>X</span>
    </a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-family:var(--mf);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='none'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      <span>Facebook</span>
    </a>
    <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-family:var(--mf);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='none'">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 10.9v8.37H9.25V10.9H6.46M7.86 6.74a1.62 1.62 0 1 0 0 3.24 1.62 1.62 0 0 0 0-3.24z"/></svg>
      <span>LinkedIn</span>
    </a>
    <a href="https://api.whatsapp.com/send?text=${encodeURIComponent(enTitle + ' ' + url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-family:var(--mf);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='none'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.572-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.461c-1.815 0-3.593-.486-5.147-1.405l-.369-.219-3.824.997 1.018-3.727-.241-.383C2.5 15.54 1.5 13.567 1.5 11.5 1.5 5.986 5.986 1.5 11.5 1.5s10 4.486 10 10-4.486 10-10 10"/></svg>
      <span>WhatsApp</span>
    </a>
  </div>
</section>`;
}

export function renderInfographicDocument(entry, options = {}) {
  const content = entry.infographicContent;
  if (!content) throw new Error('renderInfographicDocument requires an enriched article (infographicContent missing)');
  const raw = entry.coreNews || {};
  const core = content.coreNews || {};
  const dimensions = content.dimensions || [];
  const sources = content.sources || [];
  const colorway = options.colorway || 'Flame Blue';
  const defaultLang = options.defaultLang || 'EN';
  const storageKey = options.storageKeyPrefix || 'infographic';
  const animations = options.animations !== false;
  const countryName = raw.country ? (COUNTRY_NAMES[raw.country] || raw.country) : '';
  const publisher = core.publisher || raw.source || '';
  const publishedAt = core.publishedAt || raw.published_at || '';

  const dimensionsCount = dimensions.length;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
(function() {
  function getVal(k) {
    try {
      var ca = document.cookie.split(';');
      for (var i = 0; i < ca.length; i++) {
        var c = ca[i].trim();
        if (c.indexOf(k + '=') === 0) return decodeURIComponent(c.substring(k.length + 1));
      }
    } catch (e) {}
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  try {
    var l = getVal('meridian-language') || getVal('${esc(storageKey)}-lang') || '${defaultLang === '中文' ? 'cn' : 'en'}';
    var t = getVal('meridian-theme') || getVal('${esc(storageKey)}-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-lang', l);
    document.documentElement.setAttribute('lang', l === 'cn' ? 'zh-Hans' : 'en');
    document.documentElement.setAttribute('data-theme', t);
  } catch(e) {}
})();
</script>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pair(core.displayTitle).en)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gloock&family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600;700&family=Spline+Sans+Mono:wght@500;600&family=Noto+Serif+SC:wght@700;900&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#f5f4f1;--paper2:#ecebe6;--card:#fdfdfb;
  --ink:#14161a;--ink2:#4c505a;--ink3:#878b94;--line:#e0dfd9;
  --a3:#0a2d6e;--a1:#1553cf;--a2:#2fa6d9;--aink:#1043a8;
  --ia3:#cfe6ff;--ia1:#7fb0ff;--ia2:#3f7bf0;
  --inv-bg:#14161a;--inv-ink:#eceef2;
  --wash:radial-gradient(120% 60% at 50% 0%,rgba(21,83,207,.08),rgba(10,45,110,.03) 45%,transparent 75%);
  --shadow:0 1px 2px rgba(15,25,50,.04),0 10px 30px -14px rgba(15,25,50,.12);
  --gdir:135deg;
  --gh:linear-gradient(var(--gdir),var(--a3) 0%,var(--a1) 48%,var(--a2) 100%);
  --gr:linear-gradient(90deg,var(--a1),var(--a2) 60%,transparent);
  --gi:linear-gradient(var(--gdir),var(--ia3) 0%,var(--ia1) 48%,var(--ia2) 100%);
  --df:"Gloock",georgia,serif;
  --if:"Instrument Serif",georgia,serif;
  --bf:"Hanken Grotesk","Helvetica Neue",arial,sans-serif;
  --mf:"Spline Sans Mono",ui-monospace,monospace;
}
[data-theme="dark"]{
  --paper:#0c0e12;--paper2:#12151b;--card:#141821;
  --ink:#eceef2;--ink2:#b3b8c2;--ink3:#7d828c;--line:#232833;
  --a3:#cfe6ff;--a1:#7fb0ff;--a2:#3f7bf0;--aink:#8ab4ff;
  --ia3:#0a2d6e;--ia1:#1553cf;--ia2:#2fa6d9;
  --inv-bg:#e9ecf2;--inv-ink:#14161a;
  --wash:radial-gradient(120% 60% at 50% 0%,rgba(127,176,255,.08),rgba(63,123,240,.03) 45%,transparent 75%);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -14px rgba(0,0,0,.55);
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--ink);font-family:var(--bf);font-size:17px;line-height:1.6;overflow-x:hidden;transition:background .35s,color .35s}
a{color:var(--aink)}a:hover{color:var(--a1)}
::selection{background:var(--a2);color:#fff}
html:not([data-lang="cn"]) .cn{display:none!important}
[data-lang="cn"] .en{display:none!important}
[data-lang="cn"]{--gdir:315deg;--df:"Noto Serif SC",serif;--if:"Noto Serif SC",serif;--bf:"Noto Sans SC",sans-serif}
[data-lang="cn"] [data-cjk="title"]{line-height:1.3!important;letter-spacing:.02em!important;font-style:normal!important}
[data-lang="cn"] [data-cjk="body"]{line-height:1.9!important;letter-spacing:.01em!important}
[data-lang="cn"] [data-cjk="hero"]{font-size:clamp(32px,9vw,40px)!important;line-height:1.25!important;letter-spacing:.02em!important}
[data-lang="en"] #btnEN,html:not([data-lang="cn"]) #btnEN,[data-lang="cn"] #btnCN{background:var(--ink)!important;color:var(--paper)!important}
@keyframes heroIn{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:none}}
</style>
</helmet>

<div id="mProgress" aria-hidden="true" style="position:fixed;top:0;left:0;height:3px;width:0%;background:var(--gh);z-index:60"></div>

<nav aria-label="Controls" style="position:fixed;top:12px;right:12px;z-index:50;display:flex;align-items:center;gap:8px">
  <button id="btnNavShare" onClick="{{ sharePage }}" aria-label="Share page" style="display:flex;align-items:center;gap:5px;font-family:var(--mf);font-size:12px;font-weight:600;padding:7px 13px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink2);box-shadow:var(--shadow);cursor:pointer">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
    <span class="en">Share</span>
    <span class="cn">分享</span>
  </button>
  <div style="display:flex;border:1px solid var(--line);border-radius:999px;background:var(--card);box-shadow:var(--shadow);overflow:hidden">
    <button id="btnEN" onClick="{{ toEN }}" style="font-family:var(--mf);font-size:12px;font-weight:600;letter-spacing:.06em;padding:7px 13px;border:0;background:none;color:var(--ink3);cursor:pointer">EN</button>
    <button id="btnCN" onClick="{{ toCN }}" style="font-family:'Noto Sans SC',var(--mf);font-size:12px;font-weight:600;letter-spacing:.06em;padding:7px 12px;border:0;background:none;color:var(--ink3);cursor:pointer;white-space:nowrap">中文</button>
  </div>
  <button onClick="{{ flipTheme }}" aria-label="Toggle theme" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:conic-gradient(var(--ink) 0 50%,var(--card) 50% 100%);box-shadow:var(--shadow);cursor:pointer"></button>
</nav>

<header data-screen-label="Hero" style="position:relative;padding:96px 22px 40px;background:var(--wash)">
  <div style="max-width:460px;margin:0 auto;animation:heroIn .9s cubic-bezier(.22,1,.36,1) both">
    <p style="font-family:var(--mf);font-size:11.5px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--aink);display:flex;align-items:center;gap:10px;margin-bottom:24px" style-before="content:'';width:26px;height:2px;background:var(--gr)">
      <span class="en">Enriched Analysis${countryName ? ` &middot; ${esc(countryName)}` : ''}</span>
      <span class="cn">深度解析${countryName ? ` &middot; ${esc(countryName)}` : ''}</span>
    </p>
    <h1 data-cjk="hero" style="font-family:var(--df);font-size:clamp(38px,10.5vw,48px);font-weight:400;line-height:1.06;letter-spacing:-.01em;background:var(--gh);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;margin-bottom:10px;text-wrap:pretty">
      ${bi(core.displayTitle)}
    </h1>
    <p data-cjk="body" style="font-family:var(--if);font-style:italic;font-size:20px;line-height:1.45;color:var(--ink2);margin:16px 0 28px;text-wrap:pretty">
      ${bi(core.summary)}
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-family:var(--mf);font-size:12px;color:var(--ink3);border-top:1px solid var(--line);padding-top:14px">
      <span style="color:var(--ink2);font-weight:600">${esc(publisher)}</span>
      <span class="en">${esc(formatDate(publishedAt, 'en'))}</span>
      <span class="cn">${esc(formatDate(publishedAt, 'zh'))}</span>
    </div>
    ${heroStatStrip(dimensions)}
  </div>
</header>

<main style="max-width:460px;margin:0 auto;padding:0 22px 40px">

<section data-screen-label="The Story" data-reveal style="margin-top:52px">
  <p style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);display:flex;align-items:center;gap:12px;margin-bottom:18px" style-after="content:'';flex:1;height:1px;background:var(--line)"><span style="color:var(--aink)">01</span><span class="en">The Story</span><span class="cn">新闻事实</span></p>
  <p data-cjk="body" style="font-size:18px;line-height:1.65;text-wrap:pretty">${bi(core.summary)}</p>
  ${(core.keyFacts || []).length ? `<ul style="list-style:none;margin-top:24px;display:grid">
    ${core.keyFacts.map((fact, i, arr) => `
    <li data-cjk="body" style="position:relative;padding:0 0 ${i === arr.length - 1 ? '0' : '16'}px 26px;font-size:16px;color:var(--ink2)" style-before="content:'';position:absolute;left:4px;top:9px;width:7px;height:7px;border-radius:50%;background:var(--gh)" ${i === arr.length - 1 ? '' : "style-after=\"content:'';position:absolute;left:7px;top:22px;bottom:2px;width:1px;background:var(--line)\""}>
      ${bi(fact.text)}
    </li>`).join('')}
  </ul>` : ''}
</section>

<section data-screen-label="Central Insight" data-reveal aria-label="Central insight" style="margin-top:56px;padding:30px 0 34px;border-top:3px solid var(--ink);border-bottom:1px solid var(--line)">
  <span aria-hidden="true" style="font-family:var(--df);font-size:56px;line-height:.6;color:var(--a2);display:block;margin-bottom:10px">&para;</span>
  <p data-cjk="title" style="font-family:var(--df);font-size:23px;line-height:1.35;letter-spacing:-.005em;background:var(--gh);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;text-wrap:pretty">
    ${bi(content.centralInsight)}
  </p>
</section>

${dimensionsCount ? `<section data-screen-label="Dimensions" style="margin-top:52px">
  <p data-reveal style="font-family:var(--mf);font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);display:flex;align-items:center;gap:12px;margin-bottom:2px" style-after="content:'';flex:1;height:1px;background:var(--line)"><span style="color:var(--aink)">02</span><span class="en">${dimensionsCount === 1 ? 'The Dimension' : `${dimensionsCount} Dimensions`}</span><span class="cn">维度分析</span></p>
  ${dimensions.map((dimension, i) => dimensionCard(dimension, i, sources)).join('')}
</section>` : ''}

${timelineSection(content.timeline)}

<section data-screen-label="Key Takeaway" data-reveal aria-label="Key takeaway" style="margin-top:60px;padding:36px 26px 38px;background:var(--inv-bg);border-radius:20px;position:relative;overflow:hidden">
  <p style="font-family:var(--mf);font-size:10.5px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--ia1);margin-bottom:14px"><span class="en">Key takeaway</span><span class="cn">核心结论</span></p>
  <p data-cjk="title" style="font-family:var(--df);font-size:24px;line-height:1.32;letter-spacing:-.005em;background:var(--gi);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;text-wrap:pretty">
    ${bi(content.keyTakeaway)}
  </p>
</section>

${listSection({
  number: '04',
  titleEn: 'What to Watch',
  titleZh: '后续关注',
  items: content.whatToWatch,
  renderItem: (item, i) => whatToWatchItem(item, i, content.whatToWatch.length)
})}

${listSection({
  number: '05',
  titleEn: 'Uncertainties',
  titleZh: '不确定因素',
  ordered: false,
  items: content.uncertainties,
  renderItem: (item, i) => uncertaintyItem(item, i, content.uncertainties.length)
})}

${sourcesSection(sources)}

${socialShareSection(core.displayTitle, core.sourceUrl || raw.url)}

</main>

<footer style="margin-top:56px;padding:26px 22px 44px;border-top:1px solid var(--line);text-align:center;font-family:var(--mf);font-size:11.5px;line-height:1.9;color:var(--ink3)">
  <b style="color:var(--ink2);font-weight:600">${esc(publisher)}</b> &middot; ${esc(publishedAt)}<br>
  <span class="en">Enriched analysis &mdash; sources listed above</span>
  <span class="cn">深度增补分析 &mdash;&mdash; 信息来源见上文</span>
</footer>
</x-dc>
<script type="text/x-dc" data-dc-script data-props="${esc(JSON.stringify({
    $preview: { width: 430, height: 940 },
    colorway: { editor: 'enum', default: colorway, options: ['Flame Blue', 'Verdigris', 'Champagne'], tsType: 'string', section: 'Appearance' },
    defaultLang: { editor: 'enum', default: defaultLang, options: ['EN', '中文'], tsType: 'string', section: 'Appearance' },
    animations: { editor: 'boolean', default: animations, tsType: 'boolean', section: 'Motion' }
  }))}">
class Component extends DCLogic {
  componentDidMount() {
    const D = document.documentElement;
    const get = k => {
      try {
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
          let c = ca[i].trim();
          if (c.indexOf(k + '=') === 0) return decodeURIComponent(c.substring(k.length + 1));
        }
      } catch (e) {}
      try { return localStorage.getItem(k); } catch (e) { return null; }
    };
    const lang = get('meridian-language') || get('${esc(storageKey)}-lang') || (this.props.defaultLang === '中文' ? 'cn' : 'en');
    const theme = get('meridian-theme') || get('${esc(storageKey)}-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    this._setLang(lang);
    this._setTheme(theme);
    const bar = document.getElementById('mProgress');
    this._onScroll = () => {
      const h = D.scrollHeight - innerHeight;
      if (bar) bar.style.width = (h > 0 ? (scrollY / h * 100) : 0) + '%';
    };
    addEventListener('scroll', this._onScroll, { passive: true });
    this._onScroll();
    if (this.props.animations === false) return;
    this._initReveals();
  }
  componentWillUnmount() { removeEventListener('scroll', this._onScroll); }
  _setLang(l) {
    const D = document.documentElement;
    D.setAttribute('data-lang', l);
    D.setAttribute('lang', l === 'cn' ? 'zh-Hans' : 'en');
    try {
      localStorage.setItem('meridian-language', l);
      localStorage.setItem('${esc(storageKey)}-lang', l);
      document.cookie = 'meridian-language=' + l + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
  }
  _setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('meridian-theme', t);
      localStorage.setItem('${esc(storageKey)}-theme', t);
      document.cookie = 'meridian-theme=' + t + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
    this._applyColorway();
  }
  _applyColorway() {
    const cw = {
      'Flame Blue': { light: ['#0a2d6e', '#1553cf', '#2fa6d9', '#1043a8'], dark: ['#cfe6ff', '#7fb0ff', '#3f7bf0', '#8ab4ff'] },
      'Verdigris':  { light: ['#0c4a40', '#127a63', '#3aa88a', '#0f6350'], dark: ['#d2f2e2', '#7fd3ae', '#2c9a78', '#8fdcba'] },
      'Champagne':  { light: ['#5f430f', '#a8781f', '#c9a04a', '#8a621a'], dark: ['#f3dfae', '#d9b56a', '#a87c2c', '#e5c885'] }
    };
    const set = cw[this.props.colorway] || cw['Flame Blue'];
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const a = dark ? set.dark : set.light, ia = dark ? set.light : set.dark;
    const s = document.documentElement.style;
    s.setProperty('--a3', a[0]); s.setProperty('--a1', a[1]); s.setProperty('--a2', a[2]); s.setProperty('--aink', a[3]);
    s.setProperty('--ia3', ia[0]); s.setProperty('--ia1', ia[1]); s.setProperty('--ia2', ia[2]);
  }
  _initReveals() {
    const ease = 'cubic-bezier(.22,1,.36,1)';
    const els = [...document.querySelectorAll('[data-reveal]')];
    els.forEach(el => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(28px)';
      el.style.transition = 'opacity .85s ' + ease + ', transform .85s ' + ease;
    });
    const bars = [...document.querySelectorAll('[data-bar]')];
    bars.forEach(b => {
      b.style.transformOrigin = 'left center';
      b.style.transform = 'scaleX(0)';
      b.style.transition = 'transform 1.1s .25s ' + ease;
    });
    const counts = [...document.querySelectorAll('[data-count]')];
    const runCount = el => {
      const txt = el.textContent.trim();
      const target = parseFloat(txt.replace(/,/g, ''));
      if (isNaN(target)) return;
      const dec = (txt.split('.')[1] || '').length;
      const grouped = txt.indexOf(',') >= 0;
      const t0 = performance.now(), dur = 1100;
      const fmt = v => {
        let s = v.toFixed(dec);
        if (grouped) s = (+s).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        return s;
      };
      const tick = now => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(target * e);
        if (p < 1) requestAnimationFrame(tick); else el.textContent = txt;
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const el = en.target;
        io.unobserve(el);
        if (el.hasAttribute('data-reveal')) {
          el.style.opacity = '1';
          el.style.transform = 'none';
          el.querySelectorAll('[data-bar]').forEach(b => { b.style.transform = 'scaleX(1)'; });
          el.querySelectorAll('[data-count]').forEach(runCount);
        } else if (el.hasAttribute('data-count')) {
          runCount(el);
        } else if (el.hasAttribute('data-bar')) {
          el.style.transform = 'scaleX(1)';
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(el => io.observe(el));
    counts.forEach(c => { if (!c.closest('[data-reveal]')) io.observe(c); });
    bars.forEach(b => { if (!b.closest('[data-reveal]')) io.observe(b); });
  }
  renderVals() {
    return {
      toEN: () => this._setLang('en'),
      toCN: () => this._setLang('cn'),
      flipTheme: () => this._setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'),
      sharePage: () => { if (typeof shareLink === 'function') shareLink(); }
    };
  }
}
function shareLink() {
  var url = window.location.href;
  var title = document.title || 'News Analysis';
  if (navigator.share) {
    navigator.share({ title: title, url: url }).catch(function() {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      var txts = document.querySelectorAll('#copyLinkTxt');
      txts.forEach(function(el) {
        var orig = el.innerHTML;
        el.innerHTML = '<span style="color:var(--a1)">✓ Copied! / 已复制</span>';
        setTimeout(function() { el.innerHTML = orig; }, 2000);
      });
    }).catch(function() {});
  }
}
</script>
</body>
</html>
`;
}
