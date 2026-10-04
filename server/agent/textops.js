/**
 * Pure text operations behind the agent's file tools: line splitting, diffing
 * (for the "+77 -98" and "L34–L52" numbers) and exact-match editing.
 *
 * Nothing here touches the disk, so every rule can be unit-tested on its own.
 */

/** Edit distance above which a diff is reported approximately instead of exactly. */
export const MAX_DIFF_D = 1500;

export const detectEol = (text) => (String(text).includes('\r\n') ? '\r\n' : '\n');

/**
 * Lines of a text, ignoring the final newline: "a\nb\n" -> ["a","b"], "" -> [].
 * CRLF is normalised so Windows files diff the same as Unix ones.
 */
export function splitLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export const countLines = (text) => splitLines(text).length;

/** `cat -n` style numbering, used for read_file output and edit hints. */
export function numberLines(lines, startLine = 1) {
  const width = Math.max(4, String(startLine + lines.length - 1).length);
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`).join('\n');
}

// ---------------------------------------------------------------------------
// Myers O(ND) diff
// ---------------------------------------------------------------------------

/**
 * Shortest edit script between two line arrays.
 * Returns ops [{t:'='|'-'|'+'}] in order, or null when the edit distance
 * exceeds `maxD` (the caller then falls back to an approximation).
 */
export function myersOps(a, b, maxD = MAX_DIFF_D) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  const MAX = Math.min(N + M, maxD);
  const OFF = MAX + 1;
  const V = new Int32Array(2 * MAX + 3);
  const trace = []; // trace[d] = V[k] for k = -d..d, after round d

  for (let d = 0; d <= MAX; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[OFF + k - 1] < V[OFF + k + 1])) x = V[OFF + k + 1];
      else x = V[OFF + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      V[OFF + k] = x;
      if (x >= N && y >= M) {
        trace.push(V.slice(OFF - d, OFF + d + 1));
        return backtrack(trace, N, M, d);
      }
    }
    trace.push(V.slice(OFF - d, OFF + d + 1));
  }
  return null;
}

function backtrack(trace, N, M, D) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1];
    const base = d - 1;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[k - 1 + base] < prev[k + 1 + base]) ? k + 1 : k - 1;
    const prevX = prev[prevK + base];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push('=');
    }
    if (x === prevX) {
      y--;
      ops.push('+');
    } else {
      x--;
      ops.push('-');
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push('=');
  }
  return ops.reverse();
}

/** Lines that exist in both, counted as a multiset (a cheap LCS upper bound). */
function multisetCommon(a, b) {
  const m = new Map();
  for (const l of a) m.set(l, (m.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) {
    const n = m.get(l);
    if (n) {
      common++;
      m.set(l, n - 1);
    }
  }
  return common;
}

/**
 * Contiguous changed regions between two line arrays, as 0-based half-open
 * index ranges into each side: { aStart, aEnd, bStart, bEnd }.
 */
function diffBlocks(a, b, maxD = MAX_DIFF_D) {
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p++;
  let s = 0;
  while (s < minLen - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  if (am.length === 0 && bm.length === 0) return { blocks: [] };
  if (am.length === 0) return { blocks: [{ aStart: p, aEnd: p, bStart: p, bEnd: p + bm.length }] };
  if (bm.length === 0) return { blocks: [{ aStart: p, aEnd: p + am.length, bStart: p, bEnd: p }] };

  const ops = myersOps(am, bm, maxD);
  if (!ops) {
    const common = multisetCommon(am, bm);
    return {
      blocks: [{ aStart: p, aEnd: p + am.length, bStart: p, bEnd: p + bm.length }],
      approximate: { added: bm.length - common, removed: am.length - common },
    };
  }

  const blocks = [];
  let ai = 0;
  let bi = 0;
  let cur = null;
  for (const op of ops) {
    if (op === '=') {
      ai++;
      bi++;
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { aStart: p + ai, aEnd: p + ai, bStart: p + bi, bEnd: p + bi };
      blocks.push(cur);
    }
    if (op === '-') {
      ai++;
      cur.aEnd = p + ai;
    } else {
      bi++;
      cur.bEnd = p + bi;
    }
  }
  return { blocks };
}

/** A cheaper diff budget for numbers that are recomputed several times a second while a file is being written. */
const LIVE_MAX_D = 300;

/**
 * "+N −M" for a file that is STILL BEING WRITTEN: `newLines` is a growing prefix of the final file.
 * The old file's not-yet-reached tail is not "removed" yet, so it is left out; huge rewrites fall
 * back to a cheap estimate rather than burning CPU on every update.
 */
export function liveDiffStats(oldLines, newLines) {
  if (newLines.length === 0) return { added: 0, removed: 0 };
  const { blocks, approximate } = diffBlocks(oldLines, newLines, LIVE_MAX_D);
  if (approximate) return { added: newLines.length, removed: Math.min(oldLines.length, newLines.length) };
  let added = 0;
  let removed = 0;
  for (const k of blocks) {
    const aLen = k.aEnd - k.aStart;
    const bLen = k.bEnd - k.bStart;
    added += bLen;
    // A change that runs to the end of BOTH texts is where the writer currently is: old lines beyond
    // what the new text has covered so far are still pending, not removed.
    const atTheFrontier = k.aEnd === oldLines.length && k.bEnd === newLines.length;
    removed += atTheFrontier ? Math.min(aLen, bLen) : aLen;
  }
  return { added, removed };
}

/**
 * Everything the UI shows about a change:
 *   added / removed  - line counts ("+77 -98")
 *   ranges           - changed line ranges in the NEW file ("L34–L52")
 *   hunks            - a small unified-diff preview (for the expandable view)
 */
export function diffSummary(oldText, newText, { context = 2, maxPreviewLines = 60 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { blocks, approximate } = diffBlocks(a, b);

  let added = 0;
  let removed = 0;
  const ranges = [];
  for (const k of blocks) {
    added += k.bEnd - k.bStart;
    removed += k.aEnd - k.aStart;
    ranges.push([k.bStart + 1, Math.max(k.bEnd, k.bStart + 1)]);
  }
  if (approximate) {
    added = approximate.added;
    removed = approximate.removed;
    return { added, removed, ranges, hunks: [], approximate: true, totalLines: b.length };
  }

  // Group blocks that are close together into one hunk.
  const groups = [];
  for (const k of blocks) {
    const last = groups[groups.length - 1];
    if (last && k.bStart - last[last.length - 1].bEnd <= context * 2) last.push(k);
    else groups.push([k]);
  }

  const hunks = [];
  let budget = maxPreviewLines;
  let truncated = false;
  for (const g of groups) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const first = g[0];
    const lastBlock = g[g.length - 1];
    const lines = [];
    const push = (line) => {
      if (budget <= 0) {
        truncated = true;
        return false;
      }
      lines.push(line);
      budget--;
      return true;
    };
    const ctxStart = Math.max(0, first.bStart - context);
    for (let i = ctxStart; i < first.bStart; i++) push({ t: ' ', n: i + 1, s: b[i] });
    for (let gi = 0; gi < g.length; gi++) {
      const k = g[gi];
      for (let i = k.aStart; i < k.aEnd; i++) push({ t: '-', o: i + 1, s: a[i] });
      for (let i = k.bStart; i < k.bEnd; i++) push({ t: '+', n: i + 1, s: b[i] });
      const next = g[gi + 1];
      if (next) for (let i = k.bEnd; i < next.bStart; i++) push({ t: ' ', n: i + 1, s: b[i] });
    }
    const ctxEnd = Math.min(b.length, lastBlock.bEnd + context);
    for (let i = lastBlock.bEnd; i < ctxEnd; i++) push({ t: ' ', n: i + 1, s: b[i] });
    hunks.push({ newStart: ctxStart + 1, lines });
  }

  return { added, removed, ranges, hunks, truncated, approximate: false, totalLines: b.length };
}

// ---------------------------------------------------------------------------
// Exact-match editing
// ---------------------------------------------------------------------------

const fail = (code, error) => ({ ok: false, code, error });

function allIndexesOf(hay, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const k = hay.indexOf(needle, from);
    if (k === -1) break;
    out.push(k);
    from = k + needle.length;
  }
  return out;
}

/** 1-based line number of a character index. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Helps the model recover from a failed match: show where its text probably lives. */
export function bestMatchHint(text, needle) {
  const lines = splitLines(text);
  const needleLines = String(needle).replace(/\r\n/g, '\n').split('\n');
  const probe = needleLines.find((l) => l.trim().length > 0);
  if (!probe) return '';
  const tokens = [...new Set(probe.match(/[A-Za-z0-9_$.-]{3,}/g) || [])];
  if (tokens.length === 0) return '';

  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const t of tokens) if (lines[i].includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best === -1 || bestScore / tokens.length < 0.5) return '';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + Math.min(needleLines.length, 8) + 2);
  return `Closest match in the file (lines ${from + 1}-${to}) — copy the text from here exactly:\n${numberLines(lines.slice(from, to), from + 1)}`;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0];

/** Re-indent replacement lines when the match differed only in leading whitespace. */
function reindent(replLines, modelIndent, fileIndent) {
  if (modelIndent === fileIndent) return replLines;
  if (fileIndent.startsWith(modelIndent)) {
    const extra = fileIndent.slice(modelIndent.length);
    return replLines.map((l) => (l.trim() ? extra + l : l));
  }
  if (modelIndent.startsWith(fileIndent)) {
    const extra = modelIndent.slice(fileIndent.length);
    return replLines.map((l) => (l.startsWith(extra) ? l.slice(extra.length) : l));
  }
  return replLines;
}

/** Whole-line match that ignores trailing spaces, then indentation. Unique match only. */
function tolerantMatch(textLines, needleLines, replace_all) {
  const trimmedNeedle = [...needleLines];
  while (trimmedNeedle.length > 1 && trimmedNeedle[trimmedNeedle.length - 1] === '') trimmedNeedle.pop();
  if (trimmedNeedle.every((l) => l.trim() === '')) return null;

  for (const norm of [(l) => l.replace(/\s+$/, ''), (l) => l.trim()]) {
    const target = trimmedNeedle.map(norm);
    const hits = [];
    for (let i = 0; i + target.length <= textLines.length; i++) {
      let all = true;
      for (let j = 0; j < target.length; j++) {
        if (norm(textLines[i + j]) !== target[j]) {
          all = false;
          break;
        }
      }
      if (all) {
        hits.push(i);
        i += target.length - 1;
      }
    }
    if (hits.length === 1 || (hits.length > 1 && replace_all)) return { hits, length: trimmedNeedle.length };
    if (hits.length > 1) return { ambiguous: hits.length };
  }
  return null;
}

/**
 * Replace `old_string` with `new_string` in `content`.
 *
 * Exact match first. If that finds nothing, a whole-line match that ignores
 * trailing whitespace / indentation is tried (a unique match only), because
 * models routinely lose leading tabs. Anything ambiguous or missing is an
 * error that tells the model exactly what to fix.
 */
/**
 * A few lines around each place the text turned up, so an ambiguous match can be
 * decided in one look instead of another read of the file. The model is told the
 * 1-based position, because `occurrence` is the one-call fix.
 */
function candidateSnippets(text, positions, { context = 2, max = 5 } = {}) {
  const lines = text.split('\n');
  const lineOf = (index) => {
    let line = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  };
  return positions.slice(0, max).map((index, i) => {
    const at = lineOf(index);
    const from = Math.max(0, at - 1 - context);
    const to = Math.min(lines.length, at + context);
    const body = lines.slice(from, to).map((l, j) => `      ${i === 0 && j === 0 ? '' : ' '} ${String(from + j + 1).padStart(4)} | ${l.length > 120 ? `${l.slice(0, 119)}…` : l}`);
    return `  occurrence ${i + 1}: line ${at}\n${body.join('\n')}`;
  }).join('\n');
}

export function applyEdit(content, { old_string, new_string, replace_all = false, occurrence } = {}) {
  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    return fail('invalid', 'old_string and new_string must both be strings.');
  }
  if (old_string === '') {
    return fail('invalid', 'old_string is empty. To create a file or replace it entirely, use write_file.');
  }
  if (old_string === new_string) {
    return fail('invalid', 'old_string and new_string are identical, so nothing would change.');
  }

  const eol = detectEol(content);
  const text = eol === '\r\n' ? content.replace(/\r\n/g, '\n') : content;
  const needle = old_string.replace(/\r\n/g, '\n');
  const repl = new_string.replace(/\r\n/g, '\n');
  const restoreEol = (s) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

  let idxs = allIndexesOf(text, needle);
  // `occurrence: 3` picks the third match — the recovery that costs one call, not
  // another read of the file to copy more context from.
  const wanted = Number.isInteger(occurrence) ? occurrence : undefined;
  if (wanted !== undefined && idxs.length > 1) {
    if (wanted < 1 || wanted > idxs.length) {
      return fail('ambiguous', `occurrence=${wanted} is out of range: old_string matches ${idxs.length} places in this file.\n${candidateSnippets(text, idxs)}`);
    }
    idxs = [idxs[wanted - 1]];
  }
  if (idxs.length > 1 && !replace_all) {
    const where = idxs.slice(0, 6).map((i) => lineAt(text, i)).join(', ');
    return fail(
      'ambiguous',
      `old_string matches ${idxs.length} places (lines ${where}${idxs.length > 6 ? ', …' : ''}). ` +
        'Here they are — pick one with occurrence=N (1-based, from the top of the file), include more surrounding lines so it is unique, or set replace_all=true to change every occurrence.\n' +
        candidateSnippets(text, idxs)
    );
  }
  if (idxs.length >= 1) {
    const startLines = idxs.map((i) => lineAt(text, i));
    let out = '';
    let from = 0;
    for (const i of idxs) {
      out += text.slice(from, i) + repl;
      from = i + needle.length;
    }
    out += text.slice(from);
    return {
      ok: true,
      content: restoreEol(out),
      replacements: idxs.length,
      startLines,
      matchedBy: 'exact',
    };
  }

  // --- tolerant, whole-line fallback ---
  const textLines = text.split('\n');
  const needleLines = needle.split('\n');
  const tol = tolerantMatch(textLines, needleLines, replace_all);
  if (tol?.ambiguous) {
    return fail(
      'ambiguous',
      `old_string matches ${tol.ambiguous} places once whitespace is ignored. Include more surrounding lines so it is unique.`
    );
  }
  if (tol) {
    const replLines = repl.split('\n');
    const firstNeedle = needleLines.find((l) => l.trim()) ?? '';
    const out = [];
    let cursor = 0;
    for (const start of tol.hits) {
      out.push(...textLines.slice(cursor, start));
      out.push(...reindent(replLines, indentOf(firstNeedle), indentOf(textLines[start])));
      cursor = start + tol.length;
    }
    out.push(...textLines.slice(cursor));
    return {
      ok: true,
      content: restoreEol(out.join('\n')),
      replacements: tol.hits.length,
      startLines: tol.hits.map((h) => h + 1),
      matchedBy: 'whitespace',
      note: 'old_string matched after ignoring indentation / trailing-space differences.',
    };
  }

  const hint = bestMatchHint(text, needle);
  return fail(
    'not_found',
    'old_string was not found in the file. It must match the file exactly (whitespace and line breaks included; ' +
      'do not include the line-number prefix from read_file).' +
      (hint ? `\n\n${hint}` : '\n\nRe-read the file with read_file and copy the text exactly.')
  );
}

/** Apply several edits to one file in order. All-or-nothing. */
export function applyEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return fail('invalid', 'edits must be a non-empty array of { old_string, new_string }.');
  }
  let current = content;
  let replacements = 0;
  const notes = [];
  for (let i = 0; i < edits.length; i++) {
    const r = applyEdit(current, edits[i] || {});
    if (!r.ok) {
      return fail(r.code, `Edit ${i + 1} of ${edits.length} failed — nothing was written.\n${r.error}`);
    }
    current = r.content;
    replacements += r.replacements;
    if (r.note) notes.push(`edit ${i + 1}: ${r.note}`);
  }
  return { ok: true, content: current, replacements, notes };
}


// ---------------------------------------------------------------------------
// Edits by LINE NUMBER (many at once, top to bottom, one call)
// ---------------------------------------------------------------------------

/** `  12\tcode` is how read_file shows lines; models sometimes paste that prefix back. */
const NUMBER_PREFIX = /^\s*\d+\t/;

/**
 * If EVERY non-empty line of a snippet starts with a read_file line-number prefix, that prefix is not
 * part of the file: strip it (and say so).
 */
export function stripLineNumberPrefix(text) {
  if (typeof text !== 'string' || !text.includes('\t')) return { text, stripped: false };
  const lines = text.split('\n');
  const real = lines.filter((l) => l.trim() !== '');
  if (real.length === 0 || !real.every((l) => NUMBER_PREFIX.test(l))) return { text, stripped: false };
  return { text: lines.map((l) => l.replace(NUMBER_PREFIX, '')).join('\n'), stripped: true };
}

const isLineEdit = (e) => e && (e.start_line !== undefined || e.insert_after_line !== undefined);

/**
 * Apply edits that name LINES instead of quoting text:
 *   { start_line, end_line?, new_string }   replace those lines (new_string "" deletes them)
 *   { insert_after_line, new_string }       insert after line N (0 = at the very top)
 * Every number refers to the file AS IT IS NOW — before any edit in this call — and the edits are applied
 * bottom-up, so earlier ones never shift later ones. Overlapping edits are an error. All-or-nothing.
 */
export function applyLineEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return fail('invalid', 'edits must be a non-empty array.');

  const eol = detectEol(content);
  const text = eol === '\r\n' ? content.replace(/\r\n/g, '\n') : content;
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  const total = lines.length;

  const ops = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const label = `Edit ${i + 1} of ${edits.length}`;
    if (typeof e.new_string !== 'string') return fail('invalid', `${label}: new_string must be a string (use "" to delete lines).`);
    const cleaned = stripLineNumberPrefix(e.new_string).text.replace(/\r\n/g, '\n');
    const insert = cleaned === '' ? [] : cleaned.replace(/\n$/, '').split('\n');

    if (e.insert_after_line !== undefined) {
      const n = Number(e.insert_after_line);
      if (!Number.isInteger(n) || n < 0 || n > total) {
        return fail('out_of_range', `${label}: insert_after_line must be 0–${total} (the file has ${total} lines).`);
      }
      if (insert.length === 0) return fail('invalid', `${label}: nothing to insert.`);
      ops.push({ i, at: n, remove: 0, insert, label });
    } else {
      const start = Number(e.start_line);
      const end = e.end_line === undefined ? start : Number(e.end_line);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
        return fail('out_of_range', `${label}: start_line/end_line must satisfy 1 ≤ start ≤ end ≤ ${total} (the file has ${total} lines); got ${e.start_line}–${e.end_line ?? e.start_line}.`);
      }
      ops.push({ i, at: start - 1, remove: end - start + 1, insert, label });
    }
  }

  // overlap check: a replaced range may not contain, or touch the inside of, another edit
  const byPos = [...ops].sort((a, b) => a.at - b.at || a.i - b.i);
  for (let k = 1; k < byPos.length; k++) {
    const prev = byPos[k - 1];
    const cur = byPos[k];
    if (prev.remove > 0 && cur.at < prev.at + prev.remove) {
      return fail('overlap', `${prev.label} (lines ${prev.at + 1}–${prev.at + prev.remove}) overlaps ${cur.label}. Edits in one call must not overlap — merge them.`);
    }
  }

  const out = lines.slice();
  // bottom-up; for two inserts at the same spot, apply the LATER one first so the earlier stays first
  for (const op of [...ops].sort((a, b) => b.at - a.at || b.i - a.i)) out.splice(op.at, op.remove, ...op.insert);

  let result = out.join('\n');
  if (trailingNewline || (lines.length === 0 && out.length > 0)) result += '\n';
  if (eol === '\r\n') result = result.replace(/\n/g, '\r\n');
  return { ok: true, content: result, replacements: ops.length, mode: 'lines' };
}

/**
 * One entry point for "apply these edits to this text": either every edit quotes text
 * (applied one after another) or every edit names lines (all relative to the current file).
 */
export function applyAnyEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return fail('invalid', 'edits must be a non-empty array.');
  const byLines = edits.filter(isLineEdit).length;
  if (byLines > 0 && byLines < edits.length) {
    return fail(
      'mixed',
      'Do not mix edit styles for one file in one call: either every edit has old_string/new_string (text), or every edit has start_line/end_line or insert_after_line (line numbers).'
    );
  }
  if (byLines === 0) {
    // models paste read_file's "  12\t" prefixes into old_string sometimes: they are not in the file
    const cleaned = edits.map((e) => {
      if (!e || typeof e.old_string !== 'string') return e;
      const o = stripLineNumberPrefix(e.old_string);
      return o.stripped ? { ...e, old_string: o.text, new_string: stripLineNumberPrefix(String(e.new_string ?? '')).text } : e;
    });
    return applyEdits(content, cleaned);
  }
  return applyLineEdits(content, edits);
}
