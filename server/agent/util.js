/**
 * Small shared helpers for the agent: ids, slugs, shell quoting, output
 * clean-up, glob matching and secret redaction. No I/O, no dependencies.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/** Directories that are never worth listing or searching unless asked for by name. */
export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.cache',
  // Bodies parked for a write whose path went missing (see loop.js): a hand-off
  // buffer, never part of the project.
  '.danav-recovered',
  '.turbo', '.vite', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  'coverage', '.idea', '.vscode', 'target', '.gradle', '.parcel-cache',
]);

export const genId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

/** "My Cool App!" -> "my-cool-app". Never empty, never starts with a dot. */
export function slugify(name, fallback = 'workspace') {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

/** POSIX single-quote escaping, safe for anything including quotes and newlines. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Keep the head and tail of a long text, dropping the middle with a clear marker. */
export function truncateMiddle(text, max, label = 'output') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… [${dropped} characters of ${label} omitted] …\n\n${s.slice(s.length - tail)}`;
}

/**
 * Terminal output is full of colour codes and `\r` progress redraws that mean
 * nothing to a model (or to a text row in the UI). Strip them.
 */
export function cleanTerminalText(text) {
  return String(text ?? '')
    // ANSI CSI / OSC escape sequences
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    // a progress bar redraws the same line with \r: keep only the final state
    .replace(/[^\n]*\r(?!\n)/g, '')
    .replace(/\r\n/g, '\n');
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Translate a glob (`*`, `**`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob, { caseInsensitive = false } = {}) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j === -1) {
        re += '\\{';
        i++;
      } else {
        re += `(?:${glob.slice(i + 1, j).split(',').map(escapeRe).join('|')})`;
        i = j + 1;
      }
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

export const hasGlobChars = (s) => /[*?{]/.test(s);

/** A glob without a slash matches the file name anywhere; otherwise the whole relative path. */
export function matchesGlob(glob, relPath, opts) {
  const re = globToRegExp(glob, opts);
  const target = glob.includes('/') ? relPath : path.posix.basename(relPath);
  return re.test(target);
}

/** Forward slashes everywhere we show or compare paths. */
export const toPosix = (p) => String(p).split(path.sep).join('/');

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------
// Tool output goes to the browser AND to a third-party model provider. If the
// agent cats a `.env`, the app's own keys must not travel with it.

const SECRET_ENV_NAMES = [
  'NOVITA_API_KEY', 'GEMINI_API_KEY', 'VYCE_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
];

/** Build a redactor for this process's known secrets plus any extra values. */
export function createRedactor(extraSecrets = []) {
  const values = new Set();
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 8) values.add(v);
  }
  for (const v of extraSecrets) if (typeof v === 'string' && v.trim().length >= 8) values.add(v.trim());
  const list = [...values].sort((a, b) => b.length - a.length);
  const redact = (text) => {
    if (typeof text !== 'string' || list.length === 0) return text;
    let out = text;
    for (const secret of list) if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    return out;
  };
  redact.secretCount = list.length;
  return redact;
}

/** Environment for child processes: the app's own secrets are removed. */
export function sanitizedEnv(base = process.env) {
  const env = { ...base };
  for (const name of SECRET_ENV_NAMES) delete env[name];
  for (const key of Object.keys(env)) if (key.startsWith('DANAV_')) delete env[key];
  return env;
}

/** Non-interactive defaults so commands never sit waiting for a prompt. */
export const NON_INTERACTIVE_ENV = {
  CI: '1',
  DEBIAN_FRONTEND: 'noninteractive',
  GIT_TERMINAL_PROMPT: '0',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  TERM: 'dumb',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};
