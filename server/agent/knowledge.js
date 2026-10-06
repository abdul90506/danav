/**
 * What this run already knows, written where no model switch can lose it.
 *
 * A run's understanding of the code lived in two places that both leak:
 * the tool results in the message history, which compaction trims as soon as
 * the context fills, and the model's own attention, which is replaced wholesale
 * when auto-fallback moves the run to a different model mid-task. The result
 * was the same file being read four and five times, each read costing a round.
 *
 * This module turns the run's ledger into a few compact lines that are pinned
 * into the system message and rebuilt every round. It carries no file bodies —
 * only which files were examined, which line ranges were seen, the landmarks
 * inside them and what the searches found. That is exactly the knowledge that
 * stops a re-read, and it is small enough to be cheaper than one.
 */

const MAX_FILES = 14;
const MAX_LANDMARKS = 4;
const MAX_SEARCHES = 6;
const MAX_LISTINGS = 6;
const MAX_BLOCK_CHARS = 2000;

const normalize = (value) => String(value || '').replace(/\\/g, '/');

/** `[[1,20],[40,60]]` -> `L1-L20, L40-L60`, with single lines written once. */
function formatRanges(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? `L${start}` : `L${start}-L${end}`))
    .join(', ');
}

/**
 * The definitions a read actually landed on, so the next call can go straight
 * to one instead of re-reading to find out where it was. Each landmark carries
 * the range it occupies: the model can ask for exactly those lines.
 */
function landmarksFor(index, displayPath, ranges) {
  const file = index?.files?.[normalize(displayPath)];
  const symbols = Array.isArray(file?.symbols) ? file.symbols : [];
  if (!symbols.length) return [];
  const sorted = [...symbols].sort((a, b) => a.line - b.line);
  const inRange = (line) => ranges.some(([start, end]) => line >= start && line <= end);
  const picked = [];
  for (let i = 0; i < sorted.length && picked.length < MAX_LANDMARKS; i++) {
    const symbol = sorted[i];
    if (!symbol?.name || !Number.isInteger(symbol.line) || !inRange(symbol.line)) continue;
    // Only where it starts. The index knows where definitions begin, not where
    // they end, and an invented end line would send the model to the wrong
    // place with confidence. `read_file symbol:"name"` gets the exact body.
    picked.push(`${symbol.name} L${symbol.line}`);
  }
  return picked;
}

/**
 * One line per file the run has examined.
 *
 * `owned` files (ones this run wrote) are stated as such — the agent knows them
 * by construction and must never spend a round reading its own output back.
 */
function fileLines(state, { displayPath, index }) {
  const led = state?.ledger;
  if (!led) return [];
  const rows = [];
  const seen = new Set();

  const push = (abs, text) => {
    const path = displayPath(abs);
    if (!path || seen.has(path)) return;
    seen.add(path);
    rows.push(`${path} ${text}`);
  };

  for (const abs of led.owned || []) push(abs, '— written by this run; you already know its contents');
  for (const abs of led.read || []) push(abs, '— read in full');
  for (const [abs, record] of led.readRanges || []) {
    const ranges = Array.isArray(record?.ranges) ? record.ranges : [];
    if (!ranges.length) continue;
    const total = Number(record.totalLines) || 0;
    const landmarks = landmarksFor(index, displayPath(abs), ranges);
    push(
      abs,
      `(${total} lines) — read ${formatRanges(ranges)}${landmarks.length ? ` · here: ${landmarks.join(', ')}` : ''}`
    );
  }
  return rows.slice(0, MAX_FILES);
}

/**
 * Folders this run already listed.
 *
 * A trace of real runs showed `list_dir` called twice with identical arguments
 * inside one run: the first listing had scrolled out of the context window, and
 * re-listing cost a whole round to learn nothing new. The block carries the
 * folder and how many entries it held, which is enough for the model to know
 * the question has been asked and answered.
 */
function listingLines(state, displayPath) {
  const roots = state?.ledger?.listedRoots;
  if (!(roots instanceof Map) || roots.size === 0) return [];
  return [...roots.entries()]
    .slice(-MAX_LISTINGS)
    .map(([abs, record]) => {
      const path = displayPath(abs) || '.';
      const count = Number(record?.count) || 0;
      const plural = count === 1 && !record?.truncated ? 'entry' : 'entries';
      return `${path === '.' ? '.' : `${path}/`} — listed, ${count}${record?.truncated ? '+' : ''} ${plural}`;
    })
    .filter(Boolean);
}

/** What the searches turned up, as `pattern -> path:line` pointers. */
function searchLines(state) {
  const hits = state?.searchHits;
  if (!(hits instanceof Map) || hits.size === 0) return [];
  return [...hits.entries()]
    .slice(-MAX_SEARCHES)
    .map(([pattern, where]) => `"${pattern}" → ${where}`);
}

/**
 * The pinned block, or '' when the run has not looked at anything yet.
 *
 * Returned as plain text to append to the system message: the system message is
 * the one part of the request that compaction never touches and that every
 * model in a fallback chain receives identically.
 */
export function buildKnowledgeBlock(state, { displayPath, index = null } = {}) {
  if (!state || typeof displayPath !== 'function') return '';
  const files = fileLines(state, { displayPath, index });
  const searches = searchLines(state);
  const listings = listingLines(state, displayPath);
  if (!files.length && !searches.length && !listings.length) return '';

  const parts = [
    '',
    '# Already examined in this run',
    'This survives model switches and context trimming. Do not re-read or re-search anything below unless you need a range it does not cover, or you have changed the file since.',
    ...files,
    ...listings,
  ];
  if (searches.length) {
    parts.push('Searches already run:', ...searches.map((line) => `- ${line}`));
  }
  let block = parts.join('\n');
  if (block.length > MAX_BLOCK_CHARS) block = `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`;
  return `\n${block}\n`;
}

/**
 * Remember where a search landed, in one short pointer line.
 *
 * Capped per entry and per run: this is a map back into the code, not a second
 * copy of the results.
 */
export function noteSearchHits(state, pattern, matches) {
  if (!state || !pattern) return;
  const hits = (state.searchHits ||= new Map());
  const where = (matches || [])
    .slice(0, 4)
    .map((m) => `${normalize(m.path)}:${m.line}`)
    .join(', ');
  const key = String(pattern).slice(0, 60);
  hits.delete(key);
  hits.set(key, where || 'no matches');
  while (hits.size > MAX_SEARCHES) hits.delete(hits.keys().next().value);
}

/**
 * The definition a line sits inside.
 *
 * This is the answer to "which code is this?" — a grep hit on its own makes the
 * model read the whole file to find out, and then read it again next round.
 */
export function enclosingSymbol(index, displayPath, line) {
  const file = index?.files?.[normalize(displayPath)];
  const symbols = Array.isArray(file?.symbols) ? file.symbols : [];
  if (!symbols.length || !Number.isInteger(line)) return null;
  const sorted = [...symbols].sort((a, b) => a.line - b.line);
  let found = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].line > line) break;
    const next = sorted[i + 1];
    found = {
      name: sorted[i].name,
      kind: sorted[i].kind || '',
      start: sorted[i].line,
      /** Where the NEXT definition starts — a boundary, never a claimed end. */
      nextAt: next && next.line > sorted[i].line ? next.line : null,
    };
  }
  // A hit hundreds of lines below the last definition is not inside it.
  if (found && found.nextAt === null && line - found.start > 400) return null;
  return found;
}
