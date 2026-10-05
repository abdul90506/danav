/**
 * Small, dependency-free adapters for web-search HTML/RSS and page-fetch errors.
 * Kept separate from the Express route so the brittle bits can be tested with
 * saved fixtures instead of relying on a live search engine.
 */

const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
};

/** Decode the entities emitted by HTML search pages and XML feeds. */
export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (full, entity) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? full;
    const hex = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return full;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return full;
    }
  });
}

/** Convert an HTML fragment to compact visible text. */
export function plainTextFromMarkup(value) {
  return decodeHtmlEntities(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}

/** News-specific queries should prefer article headlines over generic category pages. */
export function isNewsSearchQuery(query) {
  return /\b(?:news|breaking|headlines?|current\s+events?|current\s+affairs)\b/i.test(String(query ?? ''));
}

function tagText(source, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(source);
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : '';
}

/**
 * Parse Google News' public RSS search feed into dated, source-labelled stories.
 * The feed URL is supplied by the caller; parsing is pure and fixture-friendly.
 */
export function parseGoogleNewsRss(xml) {
  const items = [];
  const source = String(xml ?? '');
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  let match;

  while ((match = itemRegex.exec(source)) !== null) {
    const item = match[1];
    const title = plainTextFromMarkup(tagText(item, 'title'));
    const url = decodeHtmlEntities(tagText(item, 'link')).trim();
    const sourceMatch = /<source\b([^>]*)>([\s\S]*?)<\/source\s*>/i.exec(item);
    const sourceName = sourceMatch ? plainTextFromMarkup(sourceMatch[2]) : '';
    const sourceUrlMatch = sourceMatch?.[1]?.match(/\burl\s*=\s*(["'])(.*?)\1/i);
    const sourceUrl = sourceUrlMatch ? decodeHtmlEntities(sourceUrlMatch[2]).trim() : '';
    const rawDate = plainTextFromMarkup(tagText(item, 'pubDate'));
    const timestamp = rawDate ? Date.parse(rawDate) : Number.NaN;
    const publishedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';

    if (!title || !/^https?:\/\//i.test(url)) continue;
    items.push({
      title,
      url,
      source: sourceName,
      sourceUrl,
      publishedAt,
      snippet: publishedAt ? `Published ${publishedAt}` : '',
      _timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    });
  }

  // Google may rank an older but more relevant headline first. For a news query,
  // put the most recently published items first while retaining stable feed order.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item._timestamp - a.item._timestamp) || (a.index - b.index))
    .map(({ item }) => {
      const { _timestamp, ...result } = item;
      return result;
    });
}

function minutesSincePublished(ageText) {
  const age = plainTextFromMarkup(ageText).toLowerCase();
  if (/^(?:just now|moments ago)$/.test(age)) return 0;
  if (/^yesterday$/.test(age)) return 24 * 60;
  const match = /^(\d+|a|an|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/.exec(age);
  if (!match) return Number.POSITIVE_INFINITY;
  const quantity = /^\d+$/.test(match[1]) ? Number(match[1]) : 1;
  const minutesPerUnit = {
    second: 1 / 60,
    minute: 1,
    hour: 60,
    day: 24 * 60,
    week: 7 * 24 * 60,
    month: 30 * 24 * 60,
    year: 365 * 24 * 60,
  }[match[2]];
  return quantity * minutesPerUnit;
}

/** Parse direct publisher article cards from Brave's News vertical. */
export function parseBraveNewsSearchResults(html) {
  const source = String(html ?? '');
  const starts = [...source.matchAll(
    /<div\b(?=[^>]*\bclass=["'][^"']*\bsnippet\b[^"']*["'])(?=[^>]*\bdata-type=["']news["'])[^>]*>/gi
  )];
  const results = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = starts[i + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(https?:\/\/.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/i.exec(block);
    if (!anchor) continue;

    const titleMatch = /<div\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(block);
    const sourceMatch = /<span\b[^>]*class=["'][^"']*\bdesktop-small-semibold\b[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/i.exec(block);
    const ageMatch = /<span\b[^>]*class=["'][^"']*\b(?:age-snippet|t-tertiary)\b[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/i.exec(block);
    const descriptionMatch = /<div\b[^>]*class=["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(block);
    const url = decodeHtmlEntities(anchor[2]).trim();
    const title = plainTextFromMarkup(titleMatch?.[1] || anchor[3]);
    const publisher = plainTextFromMarkup(sourceMatch?.[1] || '');
    const age = plainTextFromMarkup(ageMatch?.[1] || '');
    const description = plainTextFromMarkup(descriptionMatch?.[1] || '');
    const snippet = [age ? `Published ${age}` : '', description].filter(Boolean).join(' — ');
    if (title && /^https?:\/\//i.test(url)) {
      results.push({
        title,
        url,
        source: publisher,
        snippet,
        age,
        ageMinutes: minutesSincePublished(age),
      });
    }
  }

  return results;
}

/** Parse the server-rendered organic result cards on Brave Search's HTML page. */
export function parseBraveSearchResults(html) {
  const source = String(html ?? '');
  const starts = [...source.matchAll(
    /<div\b(?=[^>]*\bclass=["'][^"']*\bsnippet\b[^"']*["'])(?=[^>]*\bdata-type=["']web["'])[^>]*>/gi
  )];
  const results = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = starts[i + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(https?:\/\/.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/i.exec(block);
    if (!anchor) continue;

    const titleMatch = /<div\b[^>]*class=["'][^"']*\bsearch-snippet-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(block);
    const snippetMatch = /<div\b[^>]*class=["'][^"']*\bgeneric-snippet\b[^"']*["'][^>]*>[\s\S]*?<div\b[^>]*class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(block);
    const url = decodeHtmlEntities(anchor[2]).trim();
    const title = plainTextFromMarkup(titleMatch?.[1] || anchor[3]);
    const snippet = plainTextFromMarkup(snippetMatch?.[1] || '');
    if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet });
  }

  return results;
}

/**
 * Normalize real publisher sources for the compact search trail. The saved
 * result URL (or a publisher URL supplied by an RSS source) is the authority;
 * names alone are never turned into guessed domains.
 */
export function normalizeSearchSources(sources, limit = 3) {
  if (!Array.isArray(sources)) return [];
  const max = Math.max(0, Math.min(5, Math.floor(Number(limit) || 0)));
  if (!max) return [];
  const seen = new Set();
  const out = [];

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    let domain = '';
    const providedDomain = typeof source.domain === 'string' ? source.domain.trim().toLowerCase() : '';
    if (providedDomain && !/[\s/?#@:]|\.\./.test(providedDomain)) {
      try {
        const parsed = new URL(`https://${providedDomain}`);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
        if (parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || !host.includes('.') || /^(?:localhost|.*\.localhost|.*\.local)$/.test(host)) {
          continue;
        }
        domain = host;
      } catch {
        // Fall through to the actual URL below if the display host is malformed.
      }
    }
    if (!domain) {
      for (const candidate of [source.sourceUrl, source.url]) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
          const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
          if (!host.includes('.') || /^(?:localhost|.*\.localhost|.*\.local)$/.test(host)) continue;
          domain = host;
          break;
        } catch {
          // A malformed URL is not a source we can show.
        }
      }
    }
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    const name = typeof source.name === 'string'
      ? source.name.trim().slice(0, 80)
      : typeof source.source === 'string'
        ? source.source.trim().slice(0, 80)
        : '';
    out.push({ domain, ...(name ? { name } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** The top distinct publisher sites, in the order they were actually returned. */
export function summarizeSearchSources(results, limit = 3) {
  if (!Array.isArray(results)) return [];
  return normalizeSearchSources(results.map((result) => ({
    url: result?.url,
    sourceUrl: result?.sourceUrl,
    source: result?.source,
  })), limit);
}

/** Google News article URLs are client-rendered redirect shells, not publisher articles. */
export function isGoogleNewsArticleWrapper(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ''));
    return url.hostname.toLowerCase() === 'news.google.com' && /^\/(?:rss\/)?(?:articles|read)\//i.test(url.pathname);
  } catch {
    return false;
  }
}

/** A permanent client error is not improved by retrying through reader proxies. */
export function isTerminalPageStatus(status) {
  const code = Number(status);
  return Number.isInteger(code) && code >= 400 && code < 500 && ![403, 408, 425, 429].includes(code);
}

/** Describe the actual failure instead of mislabelling every non-200 as a bot wall. */
export function describePageFetchFailure(status, statusText = '') {
  const code = Number(status);
  const suffix = Number.isInteger(code) && code > 0
    ? ` (HTTP ${code}${statusText ? ` ${String(statusText).trim()}` : ''})`
    : '';
  if (code === 404) return 'Page not found (HTTP 404).';
  if (code === 410) return 'This page has been removed (HTTP 410 Gone).';
  if (code === 401) return 'This page requires authentication (HTTP 401 Unauthorized).';
  if (code === 403) return `The site denied the request${suffix}; it may require sign-in or block automated readers.`;
  if (code === 429) return 'The site is rate-limiting requests (HTTP 429); try again later or use another source.';
  if (code >= 500) return `The site returned a server error${suffix}.`;
  if (code >= 200 && code < 300) return `The page returned no readable text${suffix}.`;
  if (suffix) return `The page returned${suffix}.`;
  return 'A network error or timeout prevented the page from loading.';
}
