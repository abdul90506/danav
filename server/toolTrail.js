import { normalizeSearchSources } from './webSearch.js';

/**
 * Disk form of the web-tool trail.
 *
 * The chat keeps a record of every tool the model ran (`toolExecutions`) so the
 * research is visible after a reload. Two things must not survive that trip
 * as-is:
 *
 * 1. A tool still marked `running`. If the tab was closed mid-search the run
 *    that would have finished it is gone, so the row would shimmer "working…"
 *    forever. It is settled to a finished-but-failed state instead.
 *
 * 2. An unbounded `detail` blob. Search results and fetched pages retain a
 *    bounded Markdown excerpt so the useful content remains readable on reload.
 *
 * What was searched, whether it worked, the resolved page title/URL, real
 * publisher hosts, and images are kept because they make the trail useful.
 */

const MAX_TRAIL_ENTRIES = 20;
const MAX_QUERY_CHARS = 300;
const MAX_SUMMARY_CHARS = 120;
const MAX_DETAIL_CHARS = 9000;
const MAX_PAGE_DETAIL_CHARS = 12000;
const MAX_PAGE_URL_CHARS = 2048;
const MAX_PAGE_TITLE_CHARS = 240;
const MAX_IMAGES = 8;
const MAX_SOURCES = 3;

const TOOL_NAMES = new Set(['web_search', 'image_search', 'fetch_url']);

export function normalizeToolExecutionsForDisk(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined;

  const cleaned = list
    .filter((t) => t && typeof t === 'object' && TOOL_NAMES.has(t.name))
    .slice(-MAX_TRAIL_ENTRIES)
    .map((t) => {
      // A tool that never finished is settled as a failure, whatever `ok` said
      // (a running entry usually has no `ok` at all, which must not read as a
      // success).
      const neverFinished = t.status !== 'done';
      const sources = normalizeSearchSources(t.sources, MAX_SOURCES);
      return {
        id: String(t.id || `tool-${Math.random().toString(36).slice(2, 10)}`),
        name: t.name,
        status: 'done',
        query: typeof t.query === 'string' ? t.query.slice(0, MAX_QUERY_CHARS) : undefined,
        url:
          t.name === 'fetch_url' && typeof t.url === 'string' && /^https?:\/\//i.test(t.url)
            ? t.url.slice(0, MAX_PAGE_URL_CHARS)
            : undefined,
        title:
          t.name === 'fetch_url' && typeof t.title === 'string'
            ? t.title.slice(0, MAX_PAGE_TITLE_CHARS)
            : undefined,
        summary:
          typeof t.summary === 'string' && t.summary !== 'Page read' && t.summary !== 'Done'
            ? t.summary.slice(0, MAX_SUMMARY_CHARS)
            : undefined,
        detail:
          typeof t.detail === 'string'
            ? t.detail.slice(0, t.name === 'fetch_url' ? MAX_PAGE_DETAIL_CHARS : MAX_DETAIL_CHARS)
            : undefined,
        ok: neverFinished ? false : t.ok !== false,
        skipped: t.skipped === true ? true : undefined,
        sources: sources.length ? sources : undefined,
        images: Array.isArray(t.images) ? t.images.slice(0, MAX_IMAGES) : undefined,
      };
    });

  return cleaned.length > 0 ? cleaned : undefined;
}
