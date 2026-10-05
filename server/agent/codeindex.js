/**
 * The code index: what files the workspace holds, what each one defines, and what
 * it imports.
 *
 * The agent used to arrive in a project with a two-level folder listing and
 * nothing else. Every task then began the same expensive way — grep for a word,
 * read the wrong file, grep again — because there was no way to ask "where is
 * createPanelStore defined?" or "which files matter for the theme work?" without
 * already knowing the answer.
 *
 * This module answers those questions from one cheap pass over the repo:
 *
 *   * one `grep` for definition-looking lines and import lines, classified in JS
 *     (the same idea as outline.js, but over single lines, since that is all grep
 *     gives back). One walk of the tree, not one read per file — which matters
 *     most in a cloud sandbox, where every read is a round trip.
 *   * import specifiers resolved to real files, so "what imports this?" and
 *     "which tests cover this?" are a lookup instead of a search.
 *   * a BM25 ranking over paths, symbol names and import targets, so a request
 *     that never names a file still lands on the right files.
 *
 * The index is cached per workspace (memory + one small JSON file) and patched in
 * place whenever the agent writes a file it already knows, so it stays correct
 * without rescanning the project after every edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, dataDir, ensureDataDir } from './config.js';
import { languageOf } from './outline.js';
import { IGNORED_DIRS } from './util.js';

export const INDEX_VERSION = 4;

/** Files worth indexing: source, config and documentation, never build output. */
const SOURCE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cs', 'swift', 'dart', 'c', 'h', 'cc', 'cpp', 'hpp',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'md', 'mdx', 'json', 'jsonc', 'yml', 'yaml', 'sh', 'bash', 'sql',
]);

const IGNORED_FILE_RE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.min\.(?:js|css)$|\.map$|\.d\.ts\.map$/;

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 6;
const MAX_SYMBOLS_PER_FILE = 80;
const MAX_IMPORTS_PER_FILE = 80;
/** How long a cached index is trusted before it is rebuilt from scratch. */
const STALE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const snippetOf = (line) => line.trim().replace(/\s+/g, ' ').replace(/\s*[{(]\s*$/, '').slice(0, 140);

/**
 * One definition line -> { name, kind }.
 *
 * Deliberately flat: the index sees matched lines, not whole files, so this is
 * "what does this line declare", with no attempt to track class bodies or fence
 * states (outline.js does that when a single file is being read properly).
 */
export function definitionOf(line, language) {
  const text = String(line || '');
  if (language === 'js' || language === 'ts' || language === 'vue') {
    let m;
    m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]*)/.exec(text);
    if (m) return { name: m[1] || 'default', kind: 'function' };
    m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/.exec(text);
    if (m) return { name: m[1], kind: 'class' };
    m = /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/.exec(text);
    if (m) return { name: m[2], kind: m[1] === 'type' ? 'type' : m[1] };
    m = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\()/.exec(text);
    if (m) return { name: m[1], kind: 'function' };
    m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:React\.)?(?:memo|forwardRef|createContext|lazy|styled)/.exec(text);
    if (m) return { name: m[1], kind: 'component' };
    m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=/.exec(text);
    if (m) return { name: m[1], kind: /^[A-Z]/.test(m[1]) ? 'const' : 'const' };
    m = /^\s*(?:app|router|server|api)\.(get|post|put|patch|delete|use|all)\(\s*['"`]([^'"`]+)/i.exec(text);
    if (m) return { name: m[2], kind: 'route' };
    m = /^\s*(?:describe|it|test)(?:\.\w+)?\(\s*['"`]([^'"`]+)/.exec(text);
    if (m) return { name: m[1], kind: 'test' };
    return null;
  }
  if (language === 'python') {
    const m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(text);
    return m ? { name: m[2], kind: m[1] === 'def' ? 'function' : 'class' } : null;
  }
  if (language === 'go') {
    const m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(text);
    if (m) return { name: m[1], kind: 'function' };
    const t = /^type\s+([A-Za-z_]\w*)/.exec(text);
    return t ? { name: t[1], kind: 'type' } : null;
  }
  if (language === 'rust') {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|impl|mod|type)\s+([A-Za-z_]\w*)/.exec(text);
    return m ? { name: m[2], kind: m[1] === 'fn' ? 'function' : 'type' } : null;
  }
  if (language === 'clike') {
    const m =
      /^\s*(?:public|private|protected|internal|static|final|abstract|override|open|suspend|async|export|pub|sealed|data|partial|virtual|\s)*\s*(class|interface|enum|struct|trait|module|namespace|object|record|fun|func|function|def|fn)\s+([A-Za-z_][\w$]*)/.exec(text);
    return m ? { name: m[2], kind: /class|interface|enum|struct|trait|record|object/.test(m[1]) ? 'class' : 'function' } : null;
  }
  if (language === 'shell') {
    const m = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(text) || /^function\s+(\w+)/.exec(text);
    return m ? { name: m[1], kind: 'function' } : null;
  }
  if (language === 'sql') {
    const m = /^\s*create\s+(?:or\s+replace\s+)?(table|view|index|function|procedure|trigger|type)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_."`\[]+)/i.exec(text);
    return m ? { name: m[2].replace(/["`[\]]/g, ''), kind: m[1].toLowerCase() } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** `import x from 'y'`, `require('y')`, `export … from 'y'`, `from y import z`. */
export function importOf(line, language) {
  const text = String(line || '');
  if (language === 'python') {
    const m = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/.exec(text);
    return m ? m[1] || m[2] : null;
  }
  const m = /(?:^|\s)(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/.exec(text)
    || /^\s*import\s+['"]([^'"]+)['"]/.exec(text)
    || /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(text)
    || /^\s*(?:use|mod)\s+([\w:]+)\s*;/.exec(text);
  return m ? m[1] : null;
}

const EXT_ORDER = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.py', '.go', '.rs'];

/**
 * A specifier plus the file it came from -> the repo file it points at, or null
 * for a package (react, node:fs) and for anything unresolved.
 *
 * Only relative specifiers are followed. Aliases ("@/components/x") are matched
 * by suffix as a second guess, which is right often enough to be worth it and
 * never invents an edge: a wrong guess would only add a "who imports this" line.
 */
export function resolveImport(spec, fromPath, has) {
  const s = String(spec || '');
  if (!s || !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('@/') && !s.startsWith('~')) return null;
  const dir = path.posix.dirname(fromPath);
  const base = path.posix.normalize(path.posix.join(dir, s.replace(/^[@~]\//, '')));
  const candidates = [];
  for (const ext of EXT_ORDER) candidates.push(`${base}${ext}`);
  for (const ext of EXT_ORDER.slice(1)) candidates.push(`${base}/index${ext}`);
  for (const c of candidates) if (has(c)) return c;
  if (!s.startsWith('.') && !s.startsWith('/')) {
    // Alias-ish (config-dependent): accept a unique suffix match, never a guess.
    const hits = [...has.all()].filter((p) => p === base || p.endsWith(`/${base}`) || p.startsWith(`${base}.`) || p.startsWith(`${base}/`));
    const withExt = hits.filter((p) => EXT_ORDER.some((e) => e && p.endsWith(e)));
    if (withExt.length === 1) return withExt[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * One pattern that matches every line worth seeing: a definition or an import.
 * It has to be valid for both JS RegExp (local workspace) and grep -P (sandbox).
 */
export const SCAN_PATTERN = [
  '^\\s*(?:export\\s+|declare\\s+|default\\s+|async\\s+)*(?:function|class|interface|enum|type|struct|trait|impl|namespace|module)\\s+[A-Za-z_$][\\w$]*',
  '^\\s*(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\()',
  '^\\s*(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*(?:React\\.)?(?:memo|forwardRef|createContext|styled)',
  '^\\s*(?:app|router|server|api)\\.(?:get|post|put|patch|delete|use|all)\\s*\\(',
  '^\\s*(?:describe|it|test)(?:\\.\\w+)?\\s*\\(\\s*[\'"`]',
  '^\\s*def\\s+[A-Za-z_]\\w*',
  '^\\s*class\\s+[A-Za-z_]\\w*',
  '^\\s*func\\s+[A-Za-z_(]',
  '^\\s*fn\\s+[A-Za-z_]\\w*',
  '^\\s*(?:import|export)\\s[^;]*?from\\s+[\'"]',
  '^\\s*import\\s+[\'"]',
  'require\\s*\\(\\s*[\'"]',
  '^\\s*from\\s+[.\\w]+\\s+import',
  '^\\s*create\\s+(?:or\\s+replace\\s+)?(?:table|view)\\b',
].join('|');

/** Sort order for indexing: shallow, source-y, small files first. */
function importance(a, b) {
  const score = (f) => (f.path.startsWith('src/') ? 0 : f.path.startsWith('server/') || f.path.startsWith('app/') || f.path.startsWith('lib/') ? 1 : 2) * 1000
    + f.path.split('/').length * 10
    + (f.size > 100_000 ? 5 : 0);
  return score(a) - score(b);
}

/**
 * A quick, stable hash of a text: enough to answer "is this the same file the
 * agent already read". Not a security hash — it never leaves the process.
 */
export function fastHash(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${s.length}:${h.toString(36)}`;
}

const indexKey = (workspace) => `${workspace.id}`;
const indexFile = (workspace) => path.join(ensureDataDir(), 'code-index', `${workspace.id}.json`);

const memory = new Map();

/**
 * Scan the workspace and return a fresh index.
 *
 * Never throws for an odd workspace: a run without an index is the old behaviour,
 * which is a working agent, just a slower one.
 */
export async function buildIndex(workspace, { maxFiles = MAX_FILES } = {}) {
  const builtAt = Date.now();
  const index = {
    version: INDEX_VERSION,
    workspaceId: workspace.id,
    root: workspace.root,
    builtAt,
    truncated: false,
    scanned: 0,
    files: {},
    edges: {},
    reverse: {},
  };

  let entries = [];
  try {
    const listing = await workspace.listTree(workspace.root, { depth: MAX_DEPTH, maxEntries: Math.max(maxFiles * 2, 4000) });
    if (!listing || !Array.isArray(listing.entries)) return null;
    entries = listing.entries;
    index.truncated = Boolean(listing.truncated);
    // listTree reports entry-count truncation, but deliberately does not call a
    // depth cap "truncated". A directory at the final indexed depth can still
    // hide source files, so the cached map must say it is partial.
    const indexableDir = (entry) => {
      const parts = String(entry.path || '').replace(/\\/g, '/').split('/');
      return entry.type === 'dir' && parts.length >= MAX_DEPTH &&
        !parts.some((part) => IGNORED_DIRS.has(part) || (part.startsWith('.') && part !== '.github'));
    };
    if (entries.some(indexableDir)) index.truncated = true;
  } catch {
    // A failed walk is not an empty project. Let getIndex retry on the next use.
    return null;
  }

  const candidates = entries
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: String(e.path).replace(/\\/g, '/'), size: Number(e.size) || 0 }))
    .filter((f) => f.path && !IGNORED_FILE_RE.test(f.path))
    // Dotfiles are configuration and scratch, not code: a project has no
    // definitions to look up in .eslintrc, and a half-written .tmp-probe is
    // noise that outranks real modules in a search.
    .filter((f) => !f.path.split('/').some((seg) => seg.startsWith('.') && seg !== '.github'))
    .filter((f) => SOURCE_EXT.has(f.path.split('.').pop().toLowerCase()) || !f.path.includes('.'))
    .filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES)
    .sort(importance);
  if (candidates.length > maxFiles) {
    index.truncated = true;
    candidates.length = maxFiles;
  }
  index.scanned = candidates.length;
  const wanted = new Map(candidates.map((f) => [f.path, f]));
  const has = (p) => wanted.has(p);
  has.all = () => wanted.keys();

  // One pass for every definition and import line in the project.
  let matches = [];
  try {
    const found = await workspace.grep({
      pattern: SCAN_PATTERN,
      path: workspace.root,
      maxResults: Math.max(4000, maxFiles * 6),
    });
    if (!found || !Array.isArray(found.matches)) throw new Error('Workspace search returned no match list.');
    matches = found.matches;
    if (found.truncated) index.truncated = true;
  } catch {
    // Keep a useful path-only result for direct callers, but do not cache it: a
    // transient search failure must not hide every definition for the whole TTL.
    index.truncated = true;
    index.builtAt = 0;
  }

  const byPath = new Map();
  for (const m of matches) {
    const p = String(m.path).replace(/\\/g, '/');
    if (!wanted.has(p)) continue;
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(m);
  }

  for (const file of candidates) {
    const hit = byPath.get(file.path) || [];
    const lang = languageOf(file.path);
    const symbols = [];
    const imports = [];
    const seen = new Set();
    for (const m of hit) {
      const line = String(m.text || '');
      const spec = importOf(line, lang);
      if (spec) {
        if (imports.length < MAX_IMPORTS_PER_FILE && !imports.includes(spec)) imports.push(spec);
        continue;
      }
      const def = definitionOf(line, lang);
      if (!def || !def.name) continue;
      const key = `${def.name}:${def.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (symbols.length < MAX_SYMBOLS_PER_FILE) {
        symbols.push({ name: def.name, kind: def.kind, line: m.line, text: snippetOf(line) });
      }
    }
    symbols.sort((a, b) => a.line - b.line);
    index.files[file.path] = { path: file.path, size: file.size, lang, symbols, imports };
  }

  link(index, has);
  return index;
}

/** Resolve every import to a sibling file, and keep the reverse map too. */
function link(index, has) {
  index.edges = {};
  index.reverse = {};
  for (const file of Object.values(index.files)) {
    const out = [];
    for (const spec of file.imports) {
      const target = resolveImport(spec, file.path, has);
      if (target && target !== file.path && !out.includes(target)) out.push(target);
    }
    if (out.length) index.edges[file.path] = out;
    for (const target of out) {
      if (!index.reverse[target]) index.reverse[target] = [];
      index.reverse[target].push(file.path);
    }
  }
  for (const list of Object.values(index.reverse)) list.sort();
}

/**
 * Patch one file in place after the agent wrote it: re-read its symbols and
 * imports from the text we already have in hand. No rescan, no extra round trip,
 * and the index cannot go stale behind an edit the agent just made.
 */
export function patchFile(index, filePath, text) {
  const key = String(filePath).replace(/\\/g, '/');
  const lang = languageOf(key);
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const symbols = [];
  const imports = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SCAN_RE.test(line)) continue;
    const spec = importOf(line, lang);
    if (spec) {
      if (imports.length < MAX_IMPORTS_PER_FILE && !imports.includes(spec)) imports.push(spec);
      continue;
    }
    const def = definitionOf(line, lang);
    if (!def || !def.name) continue;
    if (symbols.length < MAX_SYMBOLS_PER_FILE && !symbols.some((s) => s.name === def.name && s.kind === def.kind)) {
      symbols.push({ name: def.name, kind: def.kind, line: i + 1, text: snippetOf(line) });
    }
  }
  const known = new Set(Object.keys(index.files));
  index.files[key] = { path: key, size: text.length, lang, symbols, imports };
  const has = Object.assign((p) => index.files[p] !== undefined, { all: () => index.files });
  link(index, has);
  index.builtAt = Date.now();
  return { added: symbols.length, wasKnown: known.has(key) };
}

/** A file the agent deleted. */
export function forgetFile(index, filePath) {
  const key = String(filePath).replace(/\\/g, '/');
  delete index.files[key];
  const has = Object.assign((p) => index.files[p] !== undefined, { all: () => index.files });
  link(index, has);
}

const SCAN_RE = new RegExp(SCAN_PATTERN);

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function toJSON(index) {
  return JSON.stringify(index);
}

export function fromJSON(text, workspace) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== INDEX_VERSION) return null;
    if (parsed.workspaceId !== workspace.id || parsed.root !== workspace.root) return null;
    if (!Number.isFinite(parsed.builtAt) || parsed.builtAt <= 0 || !Number.isFinite(parsed.scanned) || parsed.scanned < 0) return null;
    if (typeof parsed.truncated !== 'boolean') return null;
    if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return null;
    if (!parsed.edges || typeof parsed.edges !== 'object' || Array.isArray(parsed.edges)) return null;
    if (!parsed.reverse || typeof parsed.reverse !== 'object' || Array.isArray(parsed.reverse)) return null;
    for (const [filePath, file] of Object.entries(parsed.files)) {
      if (!file || typeof file !== 'object' || file.path !== filePath || !Array.isArray(file.symbols) || !Array.isArray(file.imports)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The index for this workspace, from memory, from disk, or a fresh scan.
 *
 * `maxAgeMs` is how long a cached copy is trusted; a workspace the agent is
 * actively editing is refreshed by `patchFile` on every write anyway, so the TTL
 * only has to cover changes made outside the agent (a user, a dev server, a git
 * pull).
 */
export async function getIndex(workspace, { maxAgeMs = STALE_MS, force = false } = {}) {
  const key = indexKey(workspace);
  const cached = memory.get(key);
  const sameRoot = cached?.root === workspace.root;
  const fresh = (entry) => entry?.files && Number.isFinite(entry.builtAt) && Date.now() - entry.builtAt < maxAgeMs;
  if (!force && sameRoot && fresh(cached)) return cached;
  // A pending scan belongs to its root. Workspace IDs can be reopened at a new
  // path; never hand that caller the old root's in-flight result.
  if (!force && sameRoot && cached?.pending) return cached.pending;

  const fallback = sameRoot && fresh(cached) ? cached : null;
  const pending = (async () => {
    let index = null;
    if (!force) {
      try {
        index = fromJSON(fs.readFileSync(indexFile(workspace), 'utf8'), workspace);
      } catch {
        index = null;
      }
      if (index && Date.now() - index.builtAt >= maxAgeMs) index = null;
    }
    if (!index) {
      index = await buildIndex(workspace);
      // A walk/search failure is an optional-index miss, not a valid empty map.
      // Keep a fresh previous copy (if any) and let the next caller retry.
      if (!index || !Number.isFinite(index.builtAt) || index.builtAt <= 0) return fallback;
      saveIndex(workspace, index);
    }
    return index;
  })().catch(() => fallback);

  // Do not mutate a cached index into a placeholder: a failed promise used to
  // remain there forever, making every later getIndex call return the same null.
  const entry = { root: workspace.root, pending };
  memory.set(key, entry);
  const resolved = await pending;
  if (memory.get(key) === entry) {
    if (resolved) memory.set(key, resolved);
    else if (fallback) memory.set(key, fallback);
    else memory.delete(key);
  }
  return resolved;
}

export function saveIndex(workspace, index) {
  try {
    const file = indexFile(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, toJSON(index));
  } catch {
    /* an unwritable cache is not a failure */
  }
}

/**
 * The index in memory, if one is loaded, without building one: used by the write
 * tools, which must never pay for a scan just to keep a cache warm.
 */
export function cachedIndex(workspaceId) {
  const entry = memory.get(String(workspaceId));
  return entry && entry.files ? entry : null;
}

/** Patch a loaded index after a write. No-op when nothing is loaded. */
export function patchCachedIndex(workspaceId, filePath, text) {
  const index = cachedIndex(workspaceId);
  if (!index) return false;
  patchFile(index, filePath, text);
  invalidateRanking(index);
  saveIndex({ id: workspaceId, root: index.root }, index);
  return true;
}

/** Seed the in-memory index (the loop loads it before the prompt is built). */
export function primeIndex(workspace, index) {
  if (!index) return;
  memory.set(indexKey(workspace), index);
}

/**
 * Mark a cached index as old. A shell command can change anything on disk, and
 * this is how the agent's own `rm`/`git`/`mv` invalidates the cache without the
 * index chasing the filesystem.
 */
export function markIndexStale(workspaceId) {
  const entry = memory.get(String(workspaceId));
  if (entry && entry.files) entry.builtAt = 0;
}

/** Forget a workspace's index (a sandbox that was recreated, a workspace removed). */
export function dropIndex(workspaceId) {
  memory.delete(workspaceId);
  try {
    fs.rmSync(path.join(dataDir(), 'code-index', `${workspaceId}.json`), { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const symbolFiles = (index, name, kind) => {
  const out = [];
  const lower = String(name || '').toLowerCase();
  for (const file of Object.values(index.files)) {
    for (const s of file.symbols) {
      if (kind && s.kind !== kind) continue;
      if (s.name === name) out.push({ ...s, path: file.path, exact: true });
      else if (s.name.toLowerCase() === lower) out.push({ ...s, path: file.path, exact: true, case: true });
      else if (s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase())) out.push({ ...s, path: file.path, exact: false });
    }
  }
  out.sort((a, b) => Number(b.exact) - Number(a.exact) || b.name.length - a.name.length || a.path.localeCompare(b.path));
  return out;
};

/**
 * Where a name is defined: exact hits first, and — even when there are exact hits
 * — the closest near misses, so "toggleTheme" also surfaces "toggleThemeDark"
 * instead of hiding the one the caller probably meant.
 */
export function findDefinitions(index, name, { kind, limit = 12 } = {}) {
  const all = symbolFiles(index, name, kind);
  const exact = all.filter((s) => s.exact);
  const near = all.filter((s) => !s.exact);
  return {
    results: [...exact, ...near].slice(0, limit),
    exact: exact.length > 0,
    exactCount: exact.length,
    nearMisses: near.slice(0, 5),
    total: all.length,
  };
}

/** Which files the index points at for a name (exact definitions only). */
export function definitionPaths(index, name, kind) {
  const { results } = findDefinitions(index, name, { kind, limit: 24 });
  return [...new Set(results.filter((r) => r.exact).map((r) => r.path))];
}

// ---- relevance -------------------------------------------------------------

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'these', 'those', 'use', 'using', 'used',
  'add', 'new', 'get', 'set', 'all', 'any', 'not', 'but', 'you', 'your', 'please', 'want', 'need', 'make',
  'src', 'lib', 'index', 'main', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'json', 'file', 'files', 'code',
  'function', 'functions', 'class', 'classes', 'const', 'export', 'import', 'default', 'return', 'module',
  'modules', 'component', 'components', 'should', 'would', 'could', 'there', 'where', 'what', 'when', 'how',
  'ka', 'ke', 'ki', 'ko', 'kar', 'karo', 'aur', 'hai', 'hain', 'nahi', 'yeh', 'ye', 'wo', 'tha', 'me', 'mein',
  // Two-letter English words that are grammar, not meaning. Real two-letter
  // identifiers (db, ui, id, os, io, api parts) are not in here on purpose.
  'of', 'to', 'in', 'on', 'at', 'is', 'it', 'be', 'as', 'or', 'an', 'if', 'by', 'so', 'do', 'my', 'we', 'no', 'up',
]);

/** Split identifiers the way people read them: camelCase, snake_case, kebab-case. */
export function tokenize(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./\\:]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

const docsCache = new WeakMap();

/** One weighted bag of words per file: symbols weigh most, then path, then imports. */
function docsFor(index) {
  const cached = docsCache.get(index);
  if (cached) return cached;
  const docs = [];
  for (const file of Object.values(index.files)) {
    const counts = new Map();
    const add = (token, n) => counts.set(token, (counts.get(token) || 0) + n);
    // The file's own name is the strongest hint there is ("theme.ts" for a theme
    // question); the folders it sits in say less, so they weigh less.
    const segments = file.path.split('/');
    for (const t of tokenize(segments.pop() || '')) add(t, 3);
    for (const t of tokenize(segments.join('/'))) add(t, 1);
    for (const s of file.symbols) {
      for (const t of tokenize(s.name)) add(t, 4);
      for (const t of tokenize(s.text)) add(t, 1);
    }
    for (const spec of file.imports) for (const t of tokenize(spec)) add(t, 1);
    let len = 0;
    for (const n of counts.values()) len += n;
    docs.push({ path: file.path, counts, len, symbols: file.symbols });
  }
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const t of d.counts.keys()) df.set(t, (df.get(t) || 0) + 1);
  const built = { docs, avgLen, df, n: Math.max(1, docs.length) };
  docsCache.set(index, built);
  return built;
}

/** Drop the memoised bag-of-words after the index changes. */
export function invalidateRanking(index) {
  docsCache.delete(index);
}

/**
 * Which files matter for this request? BM25 over the index — no embeddings, no
 * network, and it explains itself: every hit says which words and symbols matched.
 */
export function rankFiles(index, query, { limit = 8, boost = (f) => 1 } = {}) {
  const { docs, avgLen, df, n } = docsFor(index);
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const scored = [];
  for (const d of docs) {
    let score = 0;
    const matched = [];
    for (const term of terms) {
      const tf = d.counts.get(term);
      if (!tf) {
        // A prefix of a longer token still counts, at a discount: "auth" finds "authorize".
        let partial = 0;
        for (const [token, count] of d.counts) if (token.startsWith(term) || term.startsWith(token)) partial += count;
        if (!partial) continue;
        const idf = Math.log(1 + (n - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
        score += 0.4 * idf * ((partial * (k1 + 1)) / (partial + k1 * (1 - b + (b * d.len) / avgLen)));
        matched.push(term);
        continue;
      }
      const idf = Math.log(1 + (n - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avgLen)));
      matched.push(term);
    }
    if (score <= 0) continue;
    const file = index.files[d.path];
    const symbols = (file?.symbols || []).filter((s) => terms.some((t) => tokenize(s.name).includes(t))).slice(0, 3);
    /**
     * A file other files import is more likely to be the thing being asked about
     * than a leaf that merely repeats the same words — and a test file repeats
     * everything, so it needs the penalty the caller applies to be worth much.
     */
    const centrality = 1 + Math.min(0.25, ((index.reverse?.[d.path] || []).length) * 0.04);
    scored.push({ path: d.path, score: score * centrality * boost(file || { path: d.path }), why: matched.slice(0, 5), symbols });
  }
  scored.sort((a, b2) => b2.score - a.score || a.path.localeCompare(b2.path));
  return scored.slice(0, limit);
}

/** Files that import this one — what a change here can break. */
export function dependentsOf(index, filePath) {
  const key = String(filePath).replace(/\\/g, '/');
  return (index.reverse?.[key] || []).slice();
}

const TEST_RE = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[a-z]+$/i;

/**
 * Is this file a test? Three ways of being one, because projects are not tidy:
 * the folder (test/, __tests__/, spec/), the name (foo.test.ts, test-loop.js),
 * and — when neither says so — a file that is mostly made of test declarations.
 * "Mostly test names" matters: a suite with 70 `it(...)` blocks otherwise reads
 * as the most important module in the project.
 */
export function isTestFile(file) {
  if (!file || !file.path) return false;
  if (TEST_RE.test(file.path)) return true;
  if (/(?:^|\/)(?:test|spec)[-._]/i.test(file.path)) return true;
  const symbols = file.symbols || [];
  return symbols.length >= 4 && symbols.filter((s) => s.kind === 'test').length >= symbols.length / 2;
}

/**
 * Test files that import this one — the ones that actually cover it.
 *
 * `strict` is the honest answer ("nothing tests this file"); without it, a file
 * with no tests of its own falls back to the test files sitting next to it, which
 * is a useful place to start but is NOT the same claim, and the caller is told
 * which one it is holding.
 */
export function testsFor(index, filePath, { strict = false } = {}) {
  const key = String(filePath).replace(/\\/g, '/');
  const direct = dependentsOf(index, key).filter((p) => TEST_RE.test(p)).slice(0, 6);
  if (direct.length || strict) return direct;
  const dir = path.posix.dirname(key);
  const base = path.posix.basename(key).replace(/\.[^.]+$/, '');
  return Object.keys(index.files)
    .filter((p) => TEST_RE.test(p) && (p.includes(base) || (dir !== '.' && p.startsWith(`${dir}/`))))
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// Rendering (what the model actually reads)
// ---------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A compact shape of the project: folders, entry points, the busiest modules. */
export function renderRepoMap(index, { limit = 24 } = {}) {
  const files = Object.values(index.files);
  if (!files.length) return '';
  const byDir = new Map();
  for (const f of files) {
    // Group by the folder the file lives in, cut to at most two levels: a project
    // reads as "src/components", not as one line per file.
    const dir = path.posix.dirname(f.path);
    const top = dir === '.' ? '(root)' : dir.split('/').slice(0, 2).join('/');
    const entry = byDir.get(top) || { files: 0, symbols: 0, dir, sample: [] };
    entry.files += 1;
    entry.symbols += f.symbols.length;
    if (entry.sample.length < 3 && f.symbols.length) entry.sample.push(`${path.posix.basename(f.path)} (${f.symbols.slice(0, 2).map((s) => s.name).join(', ')})`);
    byDir.set(top, entry);
  }
  const folders = [...byDir.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 14)
    .map(([name, v]) => `  ${name}/ — ${plural(v.files, 'file')}, ${plural(v.symbols, 'symbol')}${v.sample.length ? ` — e.g. ${v.sample.join('; ')}` : ''}`);

  const busiest = Object.entries(index.reverse || {})
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([file, importers]) => `  ${file} — imported by ${importers.length}`);

  /**
   * The files that define the most — implementation first. A test file defines
   * dozens of `it(...)` names and would otherwise fill this list, which reads as
   * "the most interesting code here is the tests".
   */
  const code = files.filter((f) => !isTestFile(f) && f.symbols.length > 2);
  const biggest = (code.length >= 4 ? code : files.filter((f) => f.symbols.length > 2))
    .slice()
    .sort((a, b) => b.symbols.length - a.symbols.length)
    .slice(0, 8)
    .map((f) => `  ${f.path} — ${plural(f.symbols.length, 'symbol')}: ${f.symbols.slice(0, 5).map((s) => s.name).join(', ')}`);

  const tests = files.filter((f) => TEST_RE.test(f.path)).length;
  const lines = [
    `${plural(files.length, 'file')} indexed${index.truncated ? ' (partial: the project is bigger than one index)' : ''}, ${plural(files.reduce((n, f) => n + f.symbols.length, 0), 'definition')}${tests ? `, ${plural(tests, 'test file')}` : ''}.`,
    folders.length ? `Folders:\n${folders.join('\n')}` : '',
    biggest.length ? `Defines the most:\n${biggest.join('\n')}` : '',
    busiest.length ? `Most depended on:\n${busiest.join('\n')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** What the index thinks is relevant to the request — with reasons. */
export function renderRelevantFiles(index, query, { limit = 8 } = {}) {
  const hits = rankFiles(index, query, { limit });
  if (!hits.length) return '';
  return hits
    .map((h) => {
      const symbols = h.symbols.length ? ` — ${h.symbols.map((s) => `${s.name} (L${s.line})`).join(', ')}` : '';
      const importers = (index.reverse?.[h.path] || []).length;
      return `- ${h.path}${symbols}${importers ? ` · imported by ${importers}` : ''}  [matched: ${h.why.join(', ')}]`;
    })
    .join('\n');
}

export const CODE_INDEX_HELP =
  '- It lists definitions, so `find_symbol` answers "where is X defined / who uses X" in one call — do not grep for a name you can look up.\n' +
  '- `relevant_files` is the index reading the request: the files it points at are where to start when nothing was named.\n' +
  '- `code_map` is the project\'s shape: folders, what defines the most, what is most depended on.\n' +
  '- The index is updated by your own writes, so it is never stale behind your edits.';
