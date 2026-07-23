# Eter News (`eter.my`) — Comprehensive GEO (Generative Engine Optimization) & SEO Blueprint

This document provides the definitive, technical optimization strategy to maximize indexing, citation frequency, organic search performance, and AI engine attribution for **Eter News** (`https://eter.my`) across traditional search engines (Google, Bing) and AI search platforms (Perplexity, ChatGPT Search, Gemini, Claude, Bing Copilot).

---

## 1. Executive Summary & Core Objectives

- **Search Engine Optimization (SEO)**: Elevate organic ranking on Google and Bing for Asian business, energy, tech, and economic coverage in both English and Chinese.
- **Generative Engine Optimization (GEO)**: Ensure `eter.my` is indexed, parsed, and cited as an authoritative primary source by LLMs and RAG pipelines for regional Southeast Asian news and renewable energy queries.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           ETER.MY GEO & SEO DUAL ENGINE                  │
├─────────────────────────────────────┬────────────────────────────────────┤
│ Traditional SEO (Google / Bing)     │ AI GEO (Perplexity / ChatGPT / Gemini)│
├─────────────────────────────────────┼────────────────────────────────────┤
│ • Indexation & PageRank             │ • Machine-readable `llms.txt`      │
│ • Google News Sitemap XML & RSS     │ • Clean-Text RAG Feed (`/api/llm`) │
│ • Semantic HTML5 Heading Hierarchy  │ • Unambiguous Provenance & Citation│
│ • Canonical URLs & Meta Tags        │ • Fact-Dense `NewsArticle` Schema  │
└─────────────────────────────────────┴────────────────────────────────────┘
```

---

## 2. Comprehensive Audit Matrix & Rescan Findings

| Dimension | Current Implementation | Identified Vulnerability | Required Technical Enhancement |
| :--- | :--- | :--- | :--- |
| **Bot Discovery & CSR** | Client-Side JS Rendering (`app.js`) | Spiders see empty loading skeleton `<div>` on main pages without executing JS. | Pre-render critical meta tags, titles & JSON-LD server-side in `src/server.js`. |
| **`sitemap.xml`** | Static 2-URL XML file (`/` & `/read`) | Individual news articles are absent from the sitemap index. | Dynamic `/sitemap.xml` pulling published DB articles with `<news:news>` extension. |
| **RSS / RAG Feeds** | None | No structured feed for news aggregators or RAG ingestion. | Implement `/feed.xml` (RSS 2.0) and `/api/llm/latest.json` endpoints. |
| **Heading Hierarchy** | `<p>` tags for section titles | Spiders cannot parse document structure or construct featured snippets. | Replace `<p>` section titles with semantic `<h2 class="...">` tags in `render.js`. |
| **Canonical URLs** | Missing in `.dc.html` | Potential duplicate content flags across parameter variations. | Inject `<link rel="canonical" href="...">` dynamically in `render.js`. |
| **`llms.txt` Standard** | 9-line high-level overview | Missing structured category indexes and `llms-full.txt`. | Expand `llms.txt` and provide a clean `llms-full.txt` summary manifest. |
| **Robots Policy** | Generic `User-agent: *` | AI crawlers (GPTBot, PerplexityBot) lack explicit permission paths for news API endpoints. | Add explicit AI bot rules and sitemap pointers in `robots.txt`. |
| **Structured Data** | `Organization` JSON-LD on homepage | Rendered pages lack `NewsArticle` schema. | Inject complete `NewsArticle` JSON-LD schema into all rendered infographic pages. |
| **Bilingual SEO** | JS-based language toggle | Search engines cannot distinguish English vs. Chinese alternate versions. | Add `<link rel="alternate" hreflang="en">` and `hreflang="zh-Hans"` tags. |

---

## 3. Generative Engine Optimization (GEO) Technical Blueprint

### 3.1 AI Crawler Policy (`public/robots.txt`)
Explicitly authorize and direct AI search crawlers to indexing feeds:

```robots.txt
User-agent: *
Allow: /
Disallow: /api/

# Authorized AI Search & LLM Crawlers
User-agent: GPTBot
User-agent: PerplexityBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Bingbot
User-agent: Bytespider
Allow: /
Allow: /rendered/
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /feed.xml
Allow: /api/news
Allow: /api/llm/latest.json

Sitemap: https://eter.my/sitemap.xml
```

### 3.2 Machine-Readable Knowledge Files (`llms.txt` & `llms-full.txt`)

Expand `public/llms.txt` to follow the standard format:

```markdown
# Eter News (by Eternalgy)

> Eter News (https://eter.my) is an independent bilingual news desk delivering daily curated regional coverage in English and Chinese.

## Core News Topics
- Regional Asia-Pacific Economy & Geopolitics
- Commercial & Industrial Solar / Energy Transition
- Regional Tech & Industrial Development

## Information Endpoints for AI Models & RAG
- Main Portal: https://eter.my/
- Today's Edition Reader: https://eter.my/read
- Dynamic XML Sitemap: https://eter.my/sitemap.xml
- RSS News Feed: https://eter.my/feed.xml
- RAG News Endpoint: https://eter.my/api/llm/latest.json

## Publisher Information
- Publisher: Eternalgy Sdn Bhd (https://eternalgy.me)
- Focus: Solar PV EPC & Clean Energy Solutions in Southeast Asia
```

### 3.3 RAG Clean-Text Endpoint (`/api/llm/latest.json`)
Provide a clean JSON endpoint structured specifically for LLM context windows:

```json
{
  "site": "Eter News",
  "url": "https://eter.my",
  "updated_at": "2026-07-23T15:50:00Z",
  "articles": [
    {
      "id": 123,
      "title": { "en": "English Title", "zh": "Chinese Title" },
      "summary": { "en": "English Summary", "zh": "Chinese Summary" },
      "key_takeaway": "Core Takeaway text",
      "url": "https://eter.my/rendered/infographic_123.dc.html",
      "published_at": "2026-07-23T10:00:00Z"
    }
  ]
}
```

---

## 4. Traditional Search Engine Optimization (SEO) Technical Blueprint

### 4.1 Dynamic Google News Sitemap (`/sitemap.xml`) & RSS (`/feed.xml`)
Serve live Google News XML sitemaps directly from PostgreSQL in `src/server.js`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://eter.my/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://eter.my/rendered/infographic_123.dc.html</loc>
    <lastmod>2026-07-23T15:00:00Z</lastmod>
    <news:news>
      <news:publication>
        <news:name>Eter News</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>2026-07-23</news:publication_date>
      <news:title>Sample Article Headline</news:title>
    </news:news>
  </url>
</urlset>
```

### 4.2 Semantic HTML & `NewsArticle` JSON-LD Schema
In `templates/infographic/render.js`, upgrade section headings to semantic `<h2 class="...">` elements and inject schema:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "NewsArticle",
  "headline": "Display Title",
  "description": "Executive Summary",
  "inLanguage": ["en", "zh-Hans"],
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://eter.my/rendered/infographic_123.dc.html"
  },
  "author": {
    "@type": "Organization",
    "name": "Eter News Desk"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Eter News",
    "url": "https://eter.my/",
    "logo": {
      "@type": "ImageObject",
      "url": "https://eter.my/assets/eternalgy-dark.png"
    }
  },
  "datePublished": "2026-07-23T10:00:00Z",
  "dateModified": "2026-07-23T10:00:00Z"
}
</script>
```

---

## 5. Actionable Implementation Roadmap

- [x] **Phase 1: Deep Rescan & Strategy Update**: Added Semantic HTML, RSS/RAG endpoints, Canonical Tags, and `llms-full.txt` specs.
- [ ] **Phase 2: AI Knowledge & Bot Rules**: Update `robots.txt`, `llms.txt`, and `llms-full.txt`.
- [ ] **Phase 3: Server Feed Routes**: Implement dynamic `/sitemap.xml`, `/feed.xml`, and `/api/llm/latest.json` in `src/server.js`.
- [ ] **Phase 4: Renderer Semantic Upgrades**: Update `templates/infographic/render.js` with `<h2 class="...">` tags, Canonical links, and `NewsArticle` JSON-LD.
- [ ] **Phase 5: Deployment & Validation**: Deploy to Railway (`eter.my`) and verify via Google Rich Results Test & Perplexity/GPTBot crawlers.
