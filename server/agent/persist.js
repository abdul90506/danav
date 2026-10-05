import { normalizeSearchSources } from '../webSearch.js';

/**
 * Disk form of an agent turn.
 *
 * An assistant message from an agent run is a chronological list of blocks —
 * text, thinking and ACTIONS (each file edit / command / search). Conversations
 * are saved on every change, so what is kept must be small and settled:
 *
 *   - an action that was still pending/running when the page went away never
 *     finished: it is stored as an interrupted failure, not a spinner
 *   - bounded summaries are kept; web tools retain a capped Markdown excerpt
 *     because fetched pages and results are user-readable in the action trail
 */

const MAX_TEXT = 200_000;
const MAX_OUTPUT = 4000;
const MAX_STR = 400;
const MAX_WEB_MARKDOWN = 9000;
const MAX_FETCH_MARKDOWN = 12000;
const FINISHED = new Set(['done', 'error', 'denied']);

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined);

function smallScalars(obj, max = MAX_STR) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = clip(v, max);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeHunks(hunks, lineBudget = 40) {
  if (!Array.isArray(hunks)) return undefined;
  let budget = lineBudget;
  const out = [];
  for (const h of hunks.slice(0, 6)) {
    if (!h || !Array.isArray(h.lines) || budget <= 0) continue;
    const lines = [];
    for (const l of h.lines) {
      if (budget-- <= 0) break;
      if (!l || typeof l.s !== 'string') continue;
      lines.push({
        t: l.t === '+' || l.t === '-' ? l.t : ' ',
        ...(Number.isFinite(l.n) ? { n: l.n } : {}),
        ...(Number.isFinite(l.o) ? { o: l.o } : {}),
        s: clip(l.s, 200),
      });
    }
    out.push({ newStart: Number.isFinite(h.newStart) ? h.newStart : 1, lines });
  }
  return out.length ? out : undefined;
}

/** The UI summary a tool produced ("+77 -98", "L34–L52", preview lines…), bounded. */
export function normalizeResult(r) {
  if (!r || typeof r !== 'object') return undefined;
  const out = smallScalars(r) || {};
  if (Array.isArray(r.ranges)) {
    out.ranges = r.ranges
      .filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]))
      .slice(0, 12)
      .map((x) => [x[0], x[1]]);
  }
  const hunks = normalizeHunks(r.hunks);
  if (hunks) out.hunks = hunks;
  if (r.check && typeof r.check === 'object') out.check = smallScalars(r.check, 200);
  if (Array.isArray(r.changes)) {
    const files = r.changes.filter((f) => f && typeof f.path === 'string').slice(0, 12);
    const share = Math.max(6, Math.floor(40 / Math.max(1, files.length)));
    out.changes = files.map((f) => ({
      path: clip(f.path, 300),
      added: Number.isFinite(f.added) ? f.added : 0,
      removed: Number.isFinite(f.removed) ? f.removed : 0,
      ...(Number.isFinite(f.edits) ? { edits: f.edits } : {}),
      ...(Array.isArray(f.ranges) ? { ranges: f.ranges.filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(0, 6).map((x) => [x[0], x[1]]) } : {}),
      ...(normalizeHunks(f.hunks, share) ? { hunks: normalizeHunks(f.hunks, share) } : {}),
    }));
  }
  if (Array.isArray(r.todos)) {
    out.todos = r.todos
      .filter((t) => t && typeof t.content === 'string')
      .slice(0, 25)
      .map((t) => ({ content: clip(t.content, 200), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
  }
  const sources = normalizeSearchSources(r.sources, 3);
  if (sources.length) out.sources = sources;
  if (typeof r.markdown === 'string' && (r.kind === 'fetch' || r.kind === 'web_search')) {
    out.markdown = r.markdown.slice(0, r.kind === 'fetch' ? MAX_FETCH_MARKDOWN : MAX_WEB_MARKDOWN);
  }
  if (Array.isArray(r.ports)) out.ports = r.ports.filter(Number.isFinite).slice(0, 4);
  if (Array.isArray(r.images)) {
    out.images = r.images
      .filter((i) => i && typeof i.url === 'string')
      .slice(0, 8)
      .map((i) => ({ title: clip(i.title || '', 80), url: clip(i.url, 500), thumbnail: clip(i.thumbnail || '', 500) }));
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeAction(a) {
  if (!a || typeof a !== 'object' || typeof a.tool !== 'string' || !a.tool) return null;
  const finished = FINISHED.has(a.status);
  return {
    id: String(a.id || `a-${Math.random().toString(36).slice(2, 10)}`),
    tool: a.tool.slice(0, 40),
    status: finished ? a.status : 'error',
    args: smallScalars(a.args, 600),
    result: normalizeResult(a.result),
    output: typeof a.output === 'string' && a.output ? a.output.slice(-MAX_OUTPUT) : undefined,
    error: finished
      ? clip(a.error, MAX_STR)
      : 'Interrupted — the page was closed or reloaded before this finished.',
    durationMs: Number.isFinite(a.durationMs) ? a.durationMs : undefined,
  };
}

/** @returns the block in disk form, or null to drop it */
export function normalizeAgentBlockForDisk(b) {
  if (!b || typeof b !== 'object') return null;
  const id = String(b.id || `blk-${Math.random().toString(36).slice(2, 8)}`);
  if (b.type === 'text') {
    const content = typeof b.content === 'string' ? b.content.slice(0, MAX_TEXT) : '';
    return content ? { id, type: 'text', content } : null;
  }
  if (b.type === 'action') {
    const action = normalizeAction(b.action);
    return action ? { id, type: 'action', action } : null;
  }
  return null;
}
