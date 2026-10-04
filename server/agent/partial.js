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
    // `end` is where the value stopped — the caller uses it to check whether the
    // text right after this field still looks like the rest of the object.
    out.push({ key: m[1], value, complete, end: start + consumed + (complete ? 1 : 0) });
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

// ---------------------------------------------------------------------------
// Repairing arguments a model actually produced
// ---------------------------------------------------------------------------

/**
 * Strip what models wrap around a JSON object: a ```json fence, or a sentence
 * before it ("Here are the arguments: {…}").
 */
export function stripWrappedJson(input) {
  let text = String(input ?? '').trim();
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first > 0 && last > first) text = text.slice(first, last + 1);
  return text.trim();
}

/**
 * `{path: 'a'}` — a model that quotes with `'` throughout, and no `"` anywhere,
 * which makes the intent unambiguous. A `'` that is neither where a string opens
 * nor where one closes is left alone, so an apostrophe inside a value survives.
 */
function convertSingleQuoted(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "'") { out += c; continue; }
    const before = out.trimEnd().slice(-1);
    const after = text.slice(i + 1).replace(/^\s+/, '').charAt(0);
    const opens = before === '' || '{[,:'.includes(before);
    const closes = '}]'.includes(after) || after === ',' || after === ':';
    out += opens || closes ? '"' : c;
  }
  return out;
}

const KEY_START = /[A-Za-z_$]/;
const KEY_CHAR = /[\w$.-]/;
const QUOTED_KEY = /^\s*"[A-Za-z_$][\w$-]*"\s*:/;
const STRUCTURAL = /^\s*[,}\]:]/;

/**
 * Make the argument text parseable, without inventing meaning.
 *
 * Weaker models mangle the JSON of a tool call in a few recognisable ways, and
 * every one of them used to cost the user a failed step:
 *   - literal newlines or tabs inside a string ("content": "a<newline>b")
 *   - unescaped quotes inside a string (<div class="wrap">)
 *   - a missing comma between members ({"path": "a" "content": "b"})
 *   - a bare key, a trailing comma, a fence or a sentence around the object
 *
 * The walk is quote aware, so a brace or a colon inside a file body is never
 * treated as structure. It returns `null` when the text cannot be repaired,
 * rather than guessing at a different meaning.
 *
 * @returns {null | { text: string, changed: boolean }}
 */
export function repairJsonText(input) {
  let source = stripWrappedJson(input);
  if (!source) return null;
  if (!source.includes('"') && source.includes("'")) source = convertSingleQuoted(source);
  let out = '';
  let i = 0;
  let inString = false;
  let changed = false;
  let expectingKey = false;
  let valueStart = 0; // where the string being read starts in `out` (for the drive-path guard)
  while (i < source.length) {
    const c = source[i];

    if (!inString) {
      // A comma that is about to be followed by a closing bracket is noise.
      if (c === ',') {
        const rest = source.slice(i + 1);
        if (/^\s*[}\]]/.test(rest)) {
          changed = true;
          i += 1;
          continue;
        }
      }
      if (c === '"') {
        inString = true;
        expectingKey = false;
        out += c;
        valueStart = out.length;
        i += 1;
        continue;
      }
      if (c === '\n' || c === '\r' || c === '\t' || c === ' ') {
        // Whitespace between tokens changes nothing — and a key may still follow.
        out += c === ' ' ? c : (changed = true, ' ');
        i += 1;
        continue;
      }
      if (expectingKey && KEY_START.test(c)) {
        // A bare key: `{path: …}` -> `{"path": …}`
        let j = i + 1;
        while (j < source.length && KEY_CHAR.test(source[j])) j += 1;
        const key = source.slice(i, j);
        if (/^\s*:/.test(source.slice(j))) {
          out += `"${key}"`;
          changed = true;
          i = j;
          expectingKey = false;
          continue;
        }
      }
      expectingKey = c === '{' || c === ',';
      out += c;
      i += 1;
      continue;
    }

    // ---- inside a string literal ----
    if (c === '\\') {
      const next = source[i + 1];
      if (next === undefined) { changed = true; out += '\\\\'; i += 1; continue; }
      // A drive path the model wrote with single backslashes (`C:\new\file.txt`):
      // JSON would read `\n` as a line break and quietly corrupt the path.
      const inPath = 'nrtbf'.includes(next) && /^[A-Za-z]:[\\/]/.test(out.slice(valueStart));
      if ('"\\/bfnrtu'.includes(next) && !inPath) {
        out += source.slice(i, i + 2); // a real escape: keep it as it is
      } else if (next === "'") {
        out += "'"; // \' — the model escaped a quote that JSON does not need escaped
        changed = true;
      } else {
        out += '\\\\' + next; // a backslash that is meant as text
        changed = true;
      }
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r' || c === '\t') {
      changed = true;
      out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t';
      i += 1;
      continue;
    }
    if (c === '"') {
      const rest = source.slice(i + 1);
      if (STRUCTURAL.test(rest) || !rest.trim()) {
        inString = false; // the string really ends here
        out += c;
        i += 1;
        continue;
      }
      if (QUOTED_KEY.test(rest)) {
        // The model left out the comma between two members.
        changed = true;
        inString = false;
        out += '",';
        i += 1;
        continue;
      }
      // Everything else is a quote that belongs to the text itself.
      changed = true;
      out += '\\"';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  if (!changed) return { text: source, changed: false };
  return { text: out, changed: true };
}

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
    let removed = 0;
    if (oldLines && name === 'write_file') {
      // Overwriting: count what really differs from the file on disk, like the final diff will.
      const live = liveDiffStats(oldLines, completeLines(body));
      removed = live.removed;
      added = live.added + (body !== '' && !body.endsWith('\n') ? 1 : 0); // + the line being typed right now
    }
    // `removed` is always a number. A brand-new file removes nothing, and leaving
    // the key off made every live update carry `removed: undefined` — a shape the
    // UI then has to defend against, and one that reads as a bug in any log.
    return { args, progress: { added, removed, tail: lastLines(body, 6) }, body };
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
  // A value can look "complete" and still be wrong: an unescaped quote inside the
  // file body ends the string early. What follows it then is neither a comma nor a
  // closing brace — so the field is really cut off, and only its whole lines may be
  // written. (Repair normally handles that case before we get here.)
  const tail = typeof content.end === 'number' ? text.slice(content.end).trim() : '';
  const complete = content.complete && (tail === '' || /^[,}\]]/.test(tail));
  let body = content.value;
  if (!complete) {
    const cut = body.lastIndexOf('\n');
    if (cut === -1) return null;
    body = body.slice(0, cut + 1); // drop the half-written last line
  }
  const lines = startedLines(body);
  if (lines < 3) return null;
  return { path, content: body, lines, truncated: !complete };
}
