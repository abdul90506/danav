/**
 * "Did I just write something that cannot even parse?" — answered the moment a file is written.
 *
 * A model that writes a file and never looks at it again ships a missing brace. So after every write
 * the file is parsed, and the verdict goes straight into the tool result: the model sees
 * "⚠ syntax error at 12:5" in the same breath as "Created index.js" and fixes it right away, instead
 * of the user finding out later.
 *
 *   JSON, JS / JSX / TS / TSX, CSS   parsed in-process (esbuild, when installed) — instant, any workspace
 *   Python, shell                    parsed in the workspace (python3 / bash), when commands may run
 *
 * It only ever says something when it is SURE: no runtime, an exotic file or a timeout means "no verdict".
 */
import { shQuote } from './util.js';

const MAX_CHECK_CHARS = 1_500_000;

let esbuildPromise = null;
function loadEsbuild() {
  if (!esbuildPromise) esbuildPromise = import('esbuild').then((m) => m.default || m).catch(() => null);
  return esbuildPromise;
}

const EXT_LOADER = { js: 'jsx', jsx: 'jsx', mjs: 'js', cjs: 'js', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', css: 'css' };
// JSON files that legitimately contain comments or trailing commas
const LOOSE_JSON = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|\.babelrc|devcontainer|settings|launch|tasks|extensions)\.json$|\.jsonc$|\.json5$/i;

const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function jsonVerdict(text) {
  try {
    JSON.parse(text);
    return { lang: 'json', ok: true };
  } catch (e) {
    // esbuild names the exact line and column; V8's own message often does not.
    const esbuild = await loadEsbuild();
    if (esbuild) {
      try {
        await esbuild.transform(text, { loader: 'json', logLevel: 'silent' });
      } catch (err) {
        const first = err?.errors?.[0];
        if (first?.location) return { lang: 'json', ok: false, message: clip(`line ${first.location.line}, column ${first.location.column + 1} — ${first.text}`) };
      }
    }
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const before = text.slice(0, Number(m[1]));
      where = ` at line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`;
    }
    const plain = e.message.replace(/,\s*".*"\s*is not valid JSON.*$/s, '').replace(/ in JSON at position \d+.*$/s, '');
    return { lang: 'json', ok: false, message: clip(`${plain}${where}`) };
  }
}

async function esbuildVerdict(text, loader, filename) {
  const esbuild = await loadEsbuild();
  if (!esbuild) return null;
  try {
    const out = await esbuild.transform(text, { loader, sourcefile: filename, logLevel: 'silent', jsx: 'preserve' });
    if (loader === 'css') {
      // esbuild's CSS parser is forgiving, like browsers: broken CSS comes back as WARNINGS, not errors.
      const bad = (out.warnings || []).find((w) => /^(Expected|Unexpected|Unterminated)/.test(w.text));
      if (bad) {
        const loc = bad.location ? `${bad.location.line}:${bad.location.column + 1} — ` : '';
        return { lang: 'css', ok: false, message: clip(`${loc}${bad.text}${bad.location?.lineText ? `  → ${clip(bad.location.lineText.trim(), 100)}` : ''}`, 260) };
      }
    }
    return { lang: loader === 'css' ? 'css' : loader, ok: true };
  } catch (e) {
    const first = e?.errors?.[0];
    if (!first) return null; // not a syntax complaint we understand: say nothing
    const loc = first.location ? `${first.location.line}:${first.location.column + 1}` : '';
    const lineText = first.location?.lineText ? `  → ${clip(first.location.lineText.trim(), 100)}` : '';
    return { lang: loader === 'css' ? 'css' : loader, ok: false, message: clip(`${loc ? `${loc} — ` : ''}${first.text}${lineText}`, 260) };
  }
}

async function commandVerdict(ws, abs, lang, command) {
  try {
    const r = await ws.exec(command, { timeoutMs: 8000 });
    if (r.timedOut || r.exitCode === 127) return null; // no interpreter here
    if (r.exitCode === 0) return { lang, ok: true };
    const msg = String(r.output || '').trim();
    return msg ? { lang, ok: false, message: clip(msg.split('\n').slice(-4).join(' ').trim(), 260) } : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('./workspaces/base.js').BaseWorkspace} ws
 * @param {string} abs  absolute path of the file that was just written
 * @param {string} rel  path as shown to the user
 * @param {string} text the new contents
 * @returns {Promise<null | { lang: string, ok: boolean, message?: string }>}
 */
export async function checkSyntax(ws, abs, rel, text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CHECK_CHARS) return null;
  const lower = rel.toLowerCase();
  const ext = lower.split('.').pop();

  if (ext === 'json' && !LOOSE_JSON.test(lower)) return jsonVerdict(text);
  if (EXT_LOADER[ext]) return esbuildVerdict(text, EXT_LOADER[ext], rel);

  // Interpreters live in the workspace; only use them where commands may run without asking first.
  const mayRun = ws.kind === 'sandbox' || ws.autoRun;
  if (!mayRun) return null;
  if (ext === 'py') {
    return commandVerdict(ws, abs, 'python', `python3 -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read(), sys.argv[1])" ${shQuote(abs)}`);
  }
  if (ext === 'sh' || ext === 'bash') return commandVerdict(ws, abs, 'shell', `bash -n ${shQuote(abs)}`);
  return null;
}

/** The sentence the model reads when a check fails. */
export const syntaxWarning = (verdict, rel) =>
  `\n⚠ SYNTAX ERROR in ${rel} (${verdict.lang}): ${verdict.message}\nThe file was written, but it will not run as it is. Read the lines around the error and fix it now, before anything else.`;
