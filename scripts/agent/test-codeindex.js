/**
 * The code index: what it extracts, how it ranks, and how the tools read it.
 *
 * The point of the index is that the agent stops arriving blind: it can ask
 * "where is this defined", "who uses it", "what will break", "which files is this
 * request about" and get an answer from one cheap pass over the project instead
 * of a grep-read-grep spiral.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../../server/agent/workspaces/local.js';
import { buildToolset } from '../../server/agent/tools.js';
import { createRedactor } from '../../server/agent/util.js';
import {
  buildIndex, definitionOf, dependentsOf, findDefinitions, importOf, patchFile, rankFiles,
  renderRepoMap, resolveImport, testsFor, tokenize,
} from '../../server/agent/codeindex.js';

const { test } = globalThis.__agentTest;
console.log('\n[code index]');

/** A tiny but realistic project: two modules, a component, a test, a doc. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-index-'));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('src/panel.ts', `/** One panel open at a time. */
export const createPanelStore = () => {
  let open: string | null = null;
  return { get: () => open, set: (id: string) => { open = id; } };
};
export const usePanelOpen = (store: any, id: string) => store.get() === id;
`);
  write('src/theme.ts', `export function toggleTheme(current: 'light' | 'dark') {
  return current === 'dark' ? 'light' : 'dark';
}
export const THEME_KEY = 'danav-theme';
`);
  write('src/App.tsx', `import { createPanelStore, usePanelOpen } from './panel';
import { toggleTheme } from './theme';

const workStore = createPanelStore();

export function App() {
  const open = usePanelOpen(workStore, 'work');
  const onToggle = () => toggleTheme('light');
  return { open, onToggle };
}
`);
  write('src/theme.test.ts', `import { toggleTheme } from './theme';
it('flips the theme', () => { if (toggleTheme('light') !== 'dark') throw new Error('no'); });
`);
  write('src/components/Card.tsx', `export function Card() { return null; }
export function CardList() { return null; }
`);
  write('src/panel.css', `.panel {
  display: flex;
}
.panel-scroll { overflow: auto; }
`);
  write('src/Widget.tsx', `export class Widget {
  private open = false;

  async toggle(id: string): Promise<void> {
    this.open = !this.open;
  }
}
`);
  write('docs/notes.md', '# Notes\n\nThe theme toggle lives in src/theme.ts.\n');
  write('package-lock.json', '{ "lockfileVersion": 3, "packages": {} }\n');
  write('dist/bundle.min.js', 'var a=1;function b(){return a}\n');
  return root;
}

async function workspaceFor(root) {
  const ws = new LocalWorkspace({ id: 'ws-index', kind: 'local', name: 'index', root, autoRun: true });
  await ws.init();
  return ws;
}

function toolsetFor(ws) {
  const tools = buildToolset({
    workspace: ws,
    runSearchTool: async () => ({ success: false, error: 'offline' }),
    redact: createRedactor(),
    lookup: async () => [],
    probe: async () => ({}),
  });
  const ctx = { signal: undefined, emit: () => {}, approve: async () => true, state: { readFiles: new Set(), plan: [], changed: new Map() } };
  return { run: (name, args) => tools.execute(name, args, ctx), ctx };
}

test('the index reads definitions, languages and imports out of one pass', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const index = await buildIndex(ws);

    // Build output and lock files are not code.
    assert.ok(!Object.keys(index.files).some((f) => f.startsWith('dist/')), 'dist is skipped');
    assert.ok(!Object.keys(index.files).includes('package-lock.json'), 'lock files are skipped');

    const panel = index.files['src/panel.ts'];
    assert.equal(panel.lang, 'ts');
    assert.deepEqual(panel.symbols.map((s) => s.name), ['createPanelStore', 'usePanelOpen']);
    assert.deepEqual(panel.symbols.map((s) => s.kind), ['function', 'function']);
    assert.equal(panel.symbols[0].line, 2);

    const app = index.files['src/App.tsx'];
    assert.deepEqual(app.imports, ['./panel', './theme']);
    assert.deepEqual(index.edges['src/App.tsx'], ['src/panel.ts', 'src/theme.ts'], 'relative imports resolve to real files');
    assert.deepEqual(dependentsOf(index, 'src/panel.ts'), ['src/App.tsx']);
    assert.deepEqual(testsFor(index, 'src/theme.ts'), ['src/theme.test.ts']);
    assert.deepEqual(testsFor(index, 'src/panel.ts', { strict: true }), [], 'nothing imports panel.ts as a test');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('definitions are found by exact name, by case, and by half-remembered name', () => {
  const index = {
    files: {
      'a.ts': { path: 'a.ts', symbols: [{ name: 'toggleTheme', kind: 'function', line: 1, text: 'function toggleTheme(a)' }], imports: [] },
      'b.ts': { path: 'b.ts', symbols: [{ name: 'toggleThemeDark', kind: 'function', line: 4, text: 'function toggleThemeDark()' }], imports: [] },
    },
  };
  const exact = findDefinitions(index, 'toggleTheme');
  assert.equal(exact.exact, true);
  assert.equal(exact.results[0].path, 'a.ts');
  assert.ok(exact.results.some((r) => r.path === 'b.ts'), 'the longer name is still offered');

  const fuzzy = findDefinitions(index, 'toggleThem');
  assert.equal(fuzzy.exact, false);
  assert.ok(fuzzy.results.length > 0, 'a typo still lands somewhere');
  assert.equal(findDefinitions(index, 'toggleTheme').nearMisses[0].name, 'toggleThemeDark', 'near misses ride along with the exact hit');
  assert.equal(findDefinitions(index, 'nope-nothing-like-this').results.length, 0, 'an unrelated name invents nothing');
});

test('ranking finds files from a request that names no file, and says why', () => {
  const index = {
    files: {
      'src/theme.ts': { path: 'src/theme.ts', symbols: [{ name: 'toggleTheme', kind: 'function', line: 1, text: 'function toggleTheme(current)' }], imports: [] },
      'src/panel.ts': { path: 'src/panel.ts', symbols: [{ name: 'createPanelStore', kind: 'function', line: 1, text: 'const createPanelStore = ()' }], imports: [] },
      'src/retry.ts': { path: 'src/retry.ts', symbols: [{ name: 'withRetry', kind: 'function', line: 1, text: 'function withRetry(fn)' }], imports: [] },
    },
  };
  const themeHits = rankFiles(index, 'the theme toggle should remember the last choice', { limit: 3 });
  assert.equal(themeHits[0].path, 'src/theme.ts');
  assert.ok(themeHits[0].why.includes('theme'), `explains the match: ${JSON.stringify(themeHits[0].why)}`);
  assert.ok(themeHits[0].symbols.some((s) => s.name === 'toggleTheme'), 'names the symbol that matched');

  const retryHits = rankFiles(index, 'where is the retry backoff handled', { limit: 3 });
  assert.equal(retryHits[0].path, 'src/retry.ts');

  assert.deepEqual(rankFiles(index, 'zzz nothing like this', { limit: 3 }), [], 'no match, no invented answer');
});

test('tokenising reads identifiers the way people write them', () => {
  assert.deepEqual(tokenize('createPanelStore'), ['create', 'panel', 'store']);
  assert.deepEqual(tokenize('src/__tests__/retry-with-backoff.test.ts'), ['tests', 'retry', 'backoff', 'test'], 'short words and stop words drop out');
  assert.deepEqual(tokenize('the store of the panel'), ['store', 'panel'], 'stop words are dropped, meaning survives');
  assert.deepEqual(tokenize('a of to'), [], 'pure stop words leave nothing to rank on');
});

test('import parsing and resolution handle the shapes that really appear', () => {
  assert.equal(importOf("import { a } from './a';", 'js'), './a');
  assert.equal(importOf("const x = require('../lib/x');", 'js'), '../lib/x');
  assert.equal(importOf("export { y } from './y'", 'ts'), './y');
  assert.equal(importOf("from .models import User", 'python'), '.models');
  assert.equal(importOf("import os", 'python'), 'os');
  assert.equal(importOf('const notAnImport = 1;', 'js'), null);

  const has = Object.assign((p) => ['src/a.ts', 'src/b/index.tsx', 'src/c.tsx'].includes(p), { all: () => ['src/a.ts', 'src/b/index.tsx', 'src/c.tsx'] });
  assert.equal(resolveImport('./a', 'src/b.ts', has), 'src/a.ts', 'extension is filled in');
  assert.equal(resolveImport('./b', 'src/a.ts', has), 'src/b/index.tsx', 'a folder resolves to its index');
  assert.equal(resolveImport('react', 'src/a.ts', has), null, 'packages are not repo edges');
  assert.equal(resolveImport('@/c', 'src/a.ts', has), 'src/c.tsx', 'a path alias is matched by suffix, never invented');
});

test('definitionOf covers the languages the agent meets, and stays quiet otherwise', () => {
  assert.deepEqual(definitionOf('export async function seed() {', 'js'), { name: 'seed', kind: 'function' });
  assert.deepEqual(definitionOf('export class Panel {}', 'ts'), { name: 'Panel', kind: 'class' });
  assert.deepEqual(definitionOf('interface Options {', 'ts'), { name: 'Options', kind: 'interface' });
  assert.deepEqual(definitionOf('  def run(self):', 'python'), { name: 'run', kind: 'function' });
  assert.deepEqual(definitionOf('func (s *Server) Start() {'.trim(), 'go'), { name: 'Start', kind: 'function' });
  assert.deepEqual(definitionOf('pub fn build() -> Self {', 'rust'), { name: 'build', kind: 'function' });
  assert.equal(definitionOf('just a sentence', 'markdown'), null);
});

test('patching a file after a write keeps the index correct without a rescan', () => {
  const index = { files: {}, edges: {}, reverse: {} };
  patchFile(index, 'src/one.ts', 'export function first() {}\nimport { x } from "./two";\n');
  assert.deepEqual(index.files['src/one.ts'].symbols.map((s) => s.name), ['first']);
  patchFile(index, 'src/two.ts', 'export const x = 1;\n');
  assert.deepEqual(index.edges['src/one.ts'], ['src/two.ts'], 'the edge appears as soon as both files are known');
  patchFile(index, 'src/one.ts', 'export function renamed() {}\n');
  assert.deepEqual(index.files['src/one.ts'].symbols.map((s) => s.name), ['renamed'], 'a rename replaces the old entry');
});

test('find_symbol answers definitions, uses and impact in one call', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);
    const r = await run('find_symbol', { name: 'createPanelStore' });

    assert.match(r.output, /src\/panel\.ts:2 — function createPanelStore/);
    assert.match(r.output, /Used in 1 file \(2 places\)/, 'the import and the call');
    assert.match(r.output, /Impact of changing src\/panel\.ts/);
    assert.match(r.output, /imported by 1: src\/App\.tsx/);
    assert.match(r.output, /no test imports it; test files in the same area/);

    const missing = await run('find_symbol', { name: 'toggleThem' });
    assert.match(missing.output, /No top-level definition of `toggleThem` in the index/);
    assert.match(missing.output, /Closest names in the index \(not matches\):/);
    assert.match(missing.output, /toggleTheme/, 'a near miss is offered, and labelled as one');

    const defsOnly = await run('find_symbol', { name: 'toggleTheme', mode: 'definitions' });
    assert.ok(!/Used in/.test(defsOnly.output), 'mode=definitions skips the reference search');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file by symbol returns the whole definition and nothing after it', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const r = await run('read_file', { path: 'src/panel.ts', symbol: 'createPanelStore' });
    assert.match(r.output, /function `createPanelStore` \(lines 2-5 of \d+\)/);
    assert.match(r.output, /let open: string \| null = null;/);
    assert.ok(!r.output.includes('usePanelOpen = (store'), 'the next definition is not swallowed');
    assert.equal(r.ui.symbol, 'createPanelStore');

    const wrong = await run('read_file', { path: 'src/panel.ts', symbol: 'nope' });
    assert.equal(wrong.ok, false, 'a name that is not there is an error the model can use, not an empty read');
    assert.match(wrong.output, /no definition matching "nope"/);
    assert.match(wrong.output, /Definitions in this file: createPanelStore \(L2\), usePanelOpen \(L\d+\)/);

    const near = await run('read_file', { path: 'src/panel.ts', symbol: 'Panel' });
    assert.match(near.output, /closest match/);
    assert.match(near.output, /near matches: usePanelOpen/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('find_symbol reaches class members and CSS rules the line index cannot hold', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    // A class member is not a top-level declaration: the index never sees it, so
    // without the fallback the answer was "no result" and the next move was a
    // blind grep.
    const method = await run('find_symbol', { name: 'toggle' });
    assert.match(method.output, /No top-level definition of `toggle` in the index/);
    assert.match(method.output, /src\/Widget\.tsx:\d+ — class member/);
    assert.match(method.output, /async toggle\(id: string\)/);
    assert.match(method.output, /read_file with symbol: "toggle"/);

    // A CSS rule, looked up with or without its dot.
    const rule = await run('find_symbol', { name: '.panel-scroll' });
    assert.match(rule.output, /src\/panel\.css:\d+ — CSS rule/);
    assert.match(rule.output, /read_file with symbol: "\.panel-scroll"/);
    const bare = await run('find_symbol', { name: 'panel-scroll' });
    assert.match(bare.output, /src\/panel\.css:\d+ — CSS rule/, 'the dot is optional');

    // Something that really is not there says so, instead of inventing a hit.
    const nothing = await run('find_symbol', { name: 'nothingNamedThis' });
    assert.match(nothing.output, /No definition of `nothingNamedThis` was found anywhere in the workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file by symbol reads a CSS rule, one-line rules included', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const block = await run('read_file', { path: 'src/panel.css', symbol: '.panel' });
    assert.match(block.output, /rule `\.panel` \(lines 1-3 of \d+\)/);
    assert.match(block.output, /display: flex/);

    const oneliner = await run('read_file', { path: 'src/panel.css', symbol: '.panel-scroll' });
    assert.match(oneliner.output, /overflow: auto/);

    const outline = await run('file_outline', { path: 'src/panel.css' });
    assert.match(outline.output, /\.panel-scroll \{ overflow: auto; \}/, 'a compact rule is in the outline too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi_edit can replace a definition by name, next to text and line edits', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const r = await run('multi_edit', {
      edits: [
        { path: 'src/theme.ts', symbol: 'toggleTheme', new_string: "export function toggleTheme() {\n  return 'system';\n}" },
        { path: 'src/panel.ts', old_string: 'let open: string | null = null;', new_string: 'let open: string | null = null; // one panel at a time' },
      ],
    });
    assert.match(r.output, /Edited/);
    const theme = fs.readFileSync(path.join(root, 'src/theme.ts'), 'utf8');
    assert.match(theme, /return 'system'/);
    assert.match(theme, /THEME_KEY/, 'the rest of the file survives');
    const panel = fs.readFileSync(path.join(root, 'src/panel.ts'), 'utf8');
    assert.match(panel, /one panel at a time/, 'a text edit in the same call still lands');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit_file replaces a named definition without the model copying its body', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const r = await run('edit_file', {
      path: 'src/theme.ts',
      symbol: 'toggleTheme',
      new_string: "export function toggleTheme(current: 'light' | 'dark', remember = true) {\n  const next = current === 'dark' ? 'light' : 'dark';\n  return next;\n}",
    });
    assert.match(r.output, /Edited src\/theme\.ts/);
    assert.match(r.output, /replaced function toggleTheme \(L1–L3\)/);

    const after = fs.readFileSync(path.join(root, 'src/theme.ts'), 'utf8');
    assert.match(after, /remember = true/);
    assert.match(after, /THEME_KEY/, 'everything after the definition survives');

    // The index followed the edit, so the new signature is findable immediately.
    const found = await run('find_symbol', { name: 'toggleTheme', mode: 'definitions' });
    assert.match(found.output, /remember = true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a partial read says what is still below it, from the index', async () => {
  const root = project();
  try {
    // A file with a real stretch between the top and its definitions, written
    // before the index is built for this run.
    const lines = [];
    for (let i = 0; i < 80; i++) lines.push(`// line ${i + 1}`);
    lines.push('export function deepThing() {', '  return 1;', '}');
    fs.writeFileSync(path.join(root, 'src/long.ts'), lines.join('\n'));

    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);
    // Any index tool loads the index for this run.
    await run('find_symbol', { name: 'toggleTheme' });

    const ranged = await run('read_file', { path: 'src/long.ts', start_line: 1, end_line: 3 });
    assert.match(ranged.output, /\d+ lines below this range\. Definitions there: deepThing \(L\d+\)\./, 'a skipped range is named, with what lives down there');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an ambiguous edit answers with the candidates, and occurrence is the one-call fix', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const bad = await run('edit_file', { path: 'src/components/Card.tsx', old_string: 'export function', new_string: 'export const' });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /matches 2 places \(lines 1, 2\)/);
    assert.match(bad.output, /occurrence 1: line 1/);
    assert.match(bad.output, /occurrence 2: line 2/);
    assert.match(bad.output, /export function Card\(\) \{ return null; \}/, 'the real line is shown, not just a number');

    const fixed = await run('edit_file', { path: 'src/components/Card.tsx', old_string: 'export function', new_string: 'export const', occurrence: 2 });
    assert.match(fixed.output, /Edited/);
    const text = fs.readFileSync(path.join(root, 'src/components/Card.tsx'), 'utf8');
    assert.match(text, /export function Card\(\)/);
    assert.match(text, /export const CardList\(\)/);

    const outOfRange = await run('edit_file', { path: 'src/components/Card.tsx', old_string: 'export', new_string: 'export const', occurrence: 99 });
    assert.equal(outOfRange.ok, false);
    assert.match(outOfRange.output, /out of range/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep_search groups hits, can ask for whole words, context and a page', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const loose = await run('grep_search', { pattern: 'toggleTheme' });
    assert.match(loose.output, /match(es)? in \d+ file/);
    assert.match(loose.output, /src\/theme\.ts:\d+:/);
    assert.match(loose.output, /src\/App\.tsx \(1\)|src\/App\.tsx:/, 'per-file counts');

    const word = await run('grep_search', { pattern: 'toggle', word: true, context: 1 });
    assert.match(word.output, /docs\/notes\.md:3: The theme toggle lives in src\/theme\.ts\./);
    assert.match(word.output, /docs\/notes\.md:2\|/, 'a context line above the hit');
    assert.ok(!/toggleTheme/.test(word.output.replace(/docs[^\n]*/g, '')), 'word=true does not match toggleTheme');

    const excluded = await run('grep_search', { pattern: 'theme', exclude: '*.md' });
    assert.ok(!excluded.output.includes('docs/notes.md'), 'exclude removes a whole file from the results');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grepping for a name the index knows comes back with the faster tool named', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);
    await run('find_symbol', { name: 'toggleTheme' }); // loads the index

    const named = await run('grep_search', { pattern: 'createPanelStore' });
    assert.match(named.output, /Tip: `createPanelStore` is a known name in this project — find_symbol\("createPanelStore"\)/);

    // Text that is not an identifier, or a name the index does not hold, stays clean.
    const text = await run('grep_search', { pattern: 'theme toggle lives' });
    assert.ok(!/Tip:/.test(text.output), 'prose is not a symbol');
    const unknown = await run('grep_search', { pattern: 'zzNotANameHere' });
    assert.ok(!/Tip:/.test(unknown.output), 'no tip for a name nothing defines');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('relevant_files and code_map answer "where does this live" without a file name', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const ranked = await run('relevant_files', { query: 'the theme toggle should remember the last choice' });
    assert.match(ranked.output, /Most relevant files for/);
    assert.match(ranked.output, /src\/theme\.ts/);
    assert.match(ranked.output, /\[matched:/);

    const map = await run('code_map', {});
    assert.match(map.output, /indexed/);
    assert.match(map.output, /Folders:/);
    assert.match(map.output, /Most depended on/);

    const folder = await run('code_map', { path: 'src/components' });
    assert.match(folder.output, /src\/components — 1 file/);
    assert.match(folder.output, /Card/);

    const nothing = await run('relevant_files', { query: 'quantum flux capacitor' });
    assert.match(nothing.output, /Nothing in the index matches/);
    assert.match(nothing.output, /Folders:/, 'the shape of the project is still useful');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the same file is not paid for twice in one run, but asking again still works', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);

    const first = await run('read_file', { path: 'src/panel.ts' });
    assert.match(first.output, /createPanelStore/);
    const second = await run('read_file', { path: 'src/panel.ts' });
    assert.match(second.output, /unchanged since you read it in this run/);
    assert.equal(second.ui.repeated, true);
    const third = await run('read_file', { path: 'src/panel.ts' });
    assert.match(third.output, /createPanelStore/, 'a determined second ask gets the file');

    // A file that really changed is never answered with the shortcut.
    await run('edit_file', { path: 'src/theme.ts', symbol: 'toggleTheme', new_string: 'export function toggleTheme() {\n  return "dark";\n}' });
    const changed = await run('read_file', { path: 'src/theme.ts' });
    assert.match(changed.output, /return "dark"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file the agent writes is in the index before the next call', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const { run } = toolsetFor(ws);
    await run('read_file', { path: 'src/panel.ts' }); // loads the index into the run
    await run('write_file', { path: 'src/retry.ts', content: 'export function retryWithBackoff(n: number) {\n  return n * 2;\n}\n' });
    const found = await run('find_symbol', { name: 'retryWithBackoff' });
    assert.match(found.output, /src\/retry\.ts:1 — function retryWithBackoff/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repo map is a shape, not a dump', async () => {
  const root = project();
  try {
    const ws = await workspaceFor(root);
    const index = await buildIndex(ws);
    const map = renderRepoMap(index);
    assert.match(map, /files? indexed/);
    assert.match(map, /src\/ —/);
    assert.ok(map.length < 2000, `compact enough for every prompt (${map.length} chars)`);
    assert.ok(!map.includes('function '), 'the map names symbols, it does not paste code');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
