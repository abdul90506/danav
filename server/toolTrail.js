/**
 * Disk form of the web-tool trail.
 *
 * The chat keeps a record of every tool the model ran (`toolExecutions`) so the
 * research is visible after a reload. Two things must not survive that trip
 * as-is:
 *
 * 1. A tool still marked `running`. If the tab was closed mid-search the run
 *    that would have finished it is gone, so the row would pulse "working…"
 *    forever. It is settled to a finished-but-failed state instead.
 *
 * 2. An unbounded `detail` blob. Tool output can be thousands of characters of
 *    page text; only a preview is worth persisting.
 *
 * Everything else — what was searched, whether it worked, the images — is kept,
 * because that is what makes the trail useful to look back at.
 */

const MAX_TRAIL_ENTRIES = 20;
const MAX_QUERY_CHARS = 300;
const MAX_SUMMARY_CHARS = 120;
const MAX_DETAIL_CHARS = 600;
const MAX_IMAGES = 8;

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
      return {
        id: String(t.id || `tool-${Math.random().toString(36).slice(2, 10)}`),
        name: t.name,
        status: 'done',
        query: typeof t.query === 'string' ? t.query.slice(0, MAX_QUERY_CHARS) : undefined,
        summary:
          typeof t.summary === 'string' && t.summary !== 'Page read' && t.summary !== 'Done'
            ? t.summary.slice(0, MAX_SUMMARY_CHARS)
            : undefined,
        detail: typeof t.detail === 'string' ? t.detail.slice(0, MAX_DETAIL_CHARS) : undefined,
        ok: neverFinished ? false : t.ok !== false,
        skipped: t.skipped === true ? true : undefined,
        images: Array.isArray(t.images) ? t.images.slice(0, MAX_IMAGES) : undefined,
      };
    });

  return cleaned.length > 0 ? cleaned : undefined;
}
