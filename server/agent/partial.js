/**
 * Reading a tool call WHILE the model is still writing it.
 *
 * A write_file call arrives as a JSON string that grows token by token:
 *     {"path": "index.html", "content": "<!DOCTYPE html>\n<html>\n<hea
 * Everything here works on such unfinished text, so the chat can show
 * "Creating  index.html  +37 −12" counting up while the file is being written,
 * and a few live lines of the code itself — and so a call that was cut off by the
 * output limit can still be rescued (see salvageWrite).
 */
import { liveDiffStats } from './textops.js';

/**
 * Decode the body of a JSON string literal that may stop anywhere.
 * @returns {{ value: string, complete: boolean, consumed: number }}
 *   complete = the closing quote was seen; consumed = characters read (not counting the quote)
 */
export function decodeJsonStringPartial(raw) {
  let out = '';
  let i = 0;
  let complete = false;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      complete = true;
      break;
    }
    if (c === '\\') {
      if (i + 1 >= raw.length) break; // a dangling backslash: the next character has not arrived yet
      const n = raw[i + 1];
      if (n === 'u') {
        if (i + 6 > raw.length) break; // \u needs four hex digits
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += 'u';
        i += 2;
        continue;
      }
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      out += n in map ? map[n] : n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, complete, consumed: i };
}

/**
 * Every `"key": "string"` whose key is in `keys`, in the order they appear — complete or still
 * being written. One pass, jumping over each decoded value, so a key that merely appears INSIDE a
 * file's text (say `"content": "` in a JSON fixture) is never mistaken for a real field.
 * @returns {Array<{ key: string, value: string, complete: boolean }>}
 */
export function extractStringFields(text, keys) {
  const re = new RegExp(`"(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"\\s*:\\s*"`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const { value, complete, consumed } = decodeJsonStringPartial(text.slice(start));
    out.push({ key: m[1], value, complete });
    re.lastIndex = start + consumed + (complete ? 1 : 0);
    if (!complete) break; // nothing after an unfinished string is meaningful yet
  }
  return out;
}

/** Lines "started" so far: "" -> 0, "a" -> 1, "a\n" -> 1, "a\nb" -> 2. */
export const startedLines = (s) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

/** Only the lines that are finished (a trailing partial line is not counted). */
export const completeLines = (s) => {
  if (s === '') return [];
  const lines = s.split('\n');
  lines.pop(); // after the last "\n" there is either nothing or a half-written line: neither is complete
  return lines.map((l) => l.replace(/\r$/, ''));
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const lastLines = (s, n) => {
  if (!s) return [];
  const lines = s.replace(/\n$/, '').split('\n');
  return lines.slice(-n).map((l) => clip(l.replace(/\r$/, ''), 160));
};

const num = (text, key) => {
  const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : undefined;
};

/**
 * What can be known about a tool call from its (possibly unfinished) arguments.
 *
 * @param {string} name tool name
 * @param {string} text the JSON arguments received so far
 * @param {object} [opts]
 * @param {string[]} [opts.oldLines] the file as it is on disk (for overwrites): enables a live diff
 * @returns {{ args: object, progress?: { added: number, removed?: number, tail: string[] }, body?: string }}
 */
export function peekPartialArgs(name, text, { oldLines } = {}) {
  const args = {};
  const FIELD_KEYS = ['path', 'file_path', 'filepath', 'file', 'command', 'cmd', 'from', 'to', 'query', 'url', 'pattern', 'cwd', 'id'];
  const BODY_KEYS = { write_file: ['content'], append_file: ['content'], edit_file: ['old_string', 'new_string'], multi_edit: ['old_string', 'new_string', 'path'] };
  const bodyKeys = BODY_KEYS[name] || [];

  // Scalar fields: only count them once their string is finished
  for (const f of extractStringFields(text, [...FIELD_KEYS, ...bodyKeys.filter((k) => k === 'path')])) {
    if (!f.complete) continue;
    const key = { file_path: 'path', filepath: 'path', file: 'path', cmd: 'command' }[f.key] || f.key;
    if (key !== 'id' && args[key] === undefined) args[key] = clip(f.value, key === 'command' ? 600 : 300);
  }

  if (!bodyKeys.length) return { args };

  // The body: what is being written right now
  const fields = extractStringFields(text, bodyKeys.filter((k) => k !== 'path'));
  if (name === 'write_file' || name === 'append_file') {
    const body = fields.find((f) => f.key === 'content')?.value ?? '';
    let added = startedLines(body);
    let removed;
    if (oldLines && name === 'write_file') {
      // Overwriting: count what really differs from the file on disk, like the final diff will.
      const live = liveDiffStats(oldLines, completeLines(body));
      removed = live.removed;
      added = live.added + (body !== '' && !body.endsWith('\n') ? 1 : 0); // + the line being typed right now
    }
    return { args, progress: { added, ...(removed !== undefined ? { removed } : {}), tail: lastLines(body, 6) }, body };
  }

  // edits: the old text is what goes away, the new text is what appears
  let removed = 0;
  let added = 0;
  let tailSource = '';
  for (const f of fields) {
    if (f.key === 'old_string') removed += startedLines(f.value);
    if (f.key === 'new_string') {
      added += startedLines(f.value);
      tailSource = f.value;
    }
  }
  if (name === 'multi_edit') {
    // line-range edits carry numbers instead of old text
    const starts = [...text.matchAll(/"start_line"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
    const ends = [...text.matchAll(/"end_line"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) removed += Math.max(0, ends[i] - starts[i] + 1);
  }
  if (fields.length === 0 && num(text, 'start_line') === undefined) return { args };
  return { args, progress: { added, removed, tail: lastLines(tailSource, 6) } };
}

/**
 * A write_file / append_file call that was cut off by the output limit still holds most
 * of a file. Rescue every COMPLETE line of it so the work is not thrown away.
 * @returns {{ path: string, content: string, lines: number, truncated: boolean } | null}
 */
export function salvageWrite(name, text) {
  if (name !== 'write_file' && name !== 'append_file') return null;
  const fields = extractStringFields(text, ['path', 'content']);
  const path = fields.find((f) => f.key === 'path' && f.complete)?.value;
  const content = fields.find((f) => f.key === 'content');
  if (!path || !content) return null;
  let body = content.value;
  if (!content.complete) {
    const cut = body.lastIndexOf('\n');
    if (cut === -1) return null;
    body = body.slice(0, cut + 1); // drop the half-written last line
  }
  const lines = startedLines(body);
  if (lines < 3) return null;
  return { path, content: body, lines, truncated: !content.complete };
}
