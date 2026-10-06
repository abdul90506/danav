/**
 * A table of contents for a source file: functions, classes, headings, selectors, routes…
 * with their line numbers, so a big file can be understood in one cheap call and then read in the
 * right chunks (read_file with ranges) instead of from top to bottom.
 *
 * Line-based pattern matching, not a real parser: it is meant to be fast, dependency-free and
 * right far more often than not, across many languages.
 */

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'super']);

const LANGUAGE_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  py: 'python', pyw: 'python',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'vue', astro: 'vue',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  go: 'go', rs: 'rust',
  java: 'clike', kt: 'clike', kts: 'clike', scala: 'clike', cs: 'clike', php: 'clike', rb: 'clike', swift: 'clike', dart: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', hpp: 'clike',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml',
};

export const languageOf = (filename) => LANGUAGE_BY_EXT[String(filename).split('.').pop().toLowerCase()] || 'unknown';

const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
const snippet = (line) => line.trim().replace(/\s+/g, ' ').replace(/\s*\{$/, '').slice(0, 110);

const JS_RULES = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, kind: 'class', opensClass: true },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::[^=>]+)?=>/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:React\.)?(?:memo|forwardRef|createContext|lazy|styled)\b/, kind: 'component' },
  { re: /^\s*(?:app|router|server|api)\.(get|post|put|patch|delete|use|all)\(\s*['"`]([^'"`]+)/i, kind: 'route' },
  { re: /^\s*(?:describe|it|test)(?:\.\w+)?\(\s*['"`]([^'"`]+)/, kind: 'test' },
];

const METHOD_RE =
  /^(\s+)(?:(?:public|private|protected|static|readonly|async|get|set|override|abstract)\s+)*([A-Za-z0-9_$#]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\s*\{/;

function runJs(lines, push) {
  let classIndent = -1;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const ind = indentOf(line);
    if (classIndent >= 0 && ind <= classIndent && !/^\s*[}\])]/.test(line)) classIndent = -1;
    for (const rule of JS_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.kind === 'function' && !m[1] && !/default/.test(line)) continue;
      if (rule.opensClass) classIndent = ind;
      push(i + 1, ind, rule.kind, line);
      return;
    }
    if (classIndent >= 0 && ind > classIndent) {
      const m = METHOD_RE.exec(line);
      if (m && !KEYWORDS.has(m[2])) push(i + 1, ind, 'method', line);
    }
  });
}

function runPython(lines, push) {
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*|^(\s*)class\s+[A-Za-z_]\w*/.exec(line);
    if (m) push(i + 1, indentOf(line), /class\s/.test(line.trimStart().slice(0, 6)) ? 'class' : 'def', line);
  });
}

function runMarkdown(lines, push) {
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) push(i + 1, (m[1].length - 1) * 2, `h${m[1].length}`, line);
  });
}

function runHtml(lines, push) {
  lines.forEach((line, i) => {
    const ind = indentOf(line);
    let m = /<h([1-6])\b[^>]*>(.*?)<\/h\1>/i.exec(line);
    if (m) return push(i + 1, ind, `h${m[1]}`, `<h${m[1]}> ${m[2].replace(/<[^>]+>/g, '').trim()}`);
    m = /<(script|style)\b([^>]*)>/i.exec(line);
    if (m) return push(i + 1, ind, m[1].toLowerCase(), `<${m[1]}${/\bsrc=["']([^"']+)/.exec(m[2]) ? ` src="${/\bsrc=["']([^"']+)/.exec(m[2])[1]}"` : ''}>`);
    m = /<(header|nav|main|section|article|aside|footer|form|dialog|table|template)\b([^>]*)>/i.exec(line);
    if (m) {
      const id = /\bid=["']([^"']+)/.exec(m[2])?.[1];
      const cls = /\bclass=["']([^"']+)/.exec(m[2])?.[1];
      return push(i + 1, ind, m[1].toLowerCase(), `<${m[1]}${id ? ` #${id}` : cls ? ` .${cls.split(/\s+/)[0]}` : ''}>`);
    }
    m = /<([a-z][\w-]*)\b[^>]*\sid=["']([^"']+)["']/i.exec(line);
    if (m) push(i + 1, ind, 'id', `<${m[1]} #${m[2]}>`);
  });
}

function runCss(lines, push) {
  let inComment = false;
  lines.forEach((line, i) => {
    if (inComment) {
      if (line.includes('*/')) inComment = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      inComment = true;
      return;
    }
    const at = /^(\s*)@(media|supports|keyframes|font-face|layer|container|mixin|include|function)\b/.exec(line);
    if (at) return push(i + 1, indentOf(line), 'at-rule', line);
    /**
     * A rule, whether it opens a block or is written on one line. The old test
     * only accepted `selector {` with the brace at the end, so a compact sheet
     * (`.panel-scroll { overflow: auto; }`) had no outline at all — and with no
     * outline, `read_file symbol: ".panel-scroll"` could not find it either.
     */
    if (/^[^\s@}\/][^{}]*\{/.test(line)) push(i + 1, 0, 'rule', line);
  });
}

function runJson(lines, push) {
  if (!/^\s*\{/.test(lines.find((l) => l.trim()) || '')) return;
  let unit = null;
  lines.forEach((line, i) => {
    const m = /^(\s+)"([^"\\]+)"\s*:/.exec(line);
    if (!m) return;
    const ind = indentOf(line);
    if (unit === null) unit = ind;
    if (ind === unit) push(i + 1, 0, 'key', line);
  });
}

function runGo(lines, push) {
  lines.forEach((line, i) => {
    if (/^func\s/.test(line)) push(i + 1, 0, 'func', line);
    else if (/^type\s+\w+\s+(struct|interface)/.test(line)) push(i + 1, 0, 'type', line);
  });
}

function runRust(lines, push) {
  lines.forEach((line, i) => {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/.test(line)) push(i + 1, indentOf(line), 'fn', line);
    else if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|impl|mod|type)\b/.test(line)) push(i + 1, indentOf(line), 'type', line);
  });
}

const CLIKE_RE =
  /^(\s*)(?:(?:public|private|protected|internal|static|final|abstract|override|open|suspend|async|export|pub|sealed|data|partial|virtual)\s+)*(class|interface|enum|struct|trait|module|namespace|object|record|fun|func|function|def|fn)\s+([A-Za-z_][\w$]*)/;

function runCLike(lines, push) {
  lines.forEach((line, i) => {
    const m = CLIKE_RE.exec(line);
    if (m) push(i + 1, indentOf(line), m[2], line);
  });
}

function runShell(lines, push) {
  lines.forEach((line, i) => {
    if (/^(?:function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*\{?/.test(line) || /^function\s+\w+/.test(line)) push(i + 1, 0, 'function', line);
  });
}

function runSql(lines, push) {
  lines.forEach((line, i) => {
    if (/^\s*create\s+(or\s+replace\s+)?(table|view|index|function|procedure|trigger|type)\b/i.test(line)) push(i + 1, 0, 'create', line);
  });
}

function runYaml(lines, push) {
  lines.forEach((line, i) => {
    if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(line)) push(i + 1, 0, 'key', line);
  });
}

const RUNNERS = {
  js: [runJs], ts: [runJs], python: [runPython], markdown: [runMarkdown], html: [runHtml], vue: [runHtml, runJs], css: [runCss],
  json: [runJson], go: [runGo], rust: [runRust], clike: [runCLike], shell: [runShell], sql: [runSql], yaml: [runYaml],
};

/**
 * @returns {{ language: string, total: number, symbols: Array<{line:number, depth:number, kind:string, text:string}>, truncated: boolean }}
 */
export function outline(text, filename, { max = 200 } = {}) {
  const language = languageOf(filename);
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const symbols = [];
  const unit = language === 'python' || language === 'clike' || language === 'rust' || language === 'go' ? 4 : 2;
  const push = (line, indent, kind, source) => symbols.push({ line, depth: Math.min(4, Math.round(indent / unit)), kind, text: snippet(source) });
  for (const run of RUNNERS[language] || []) run(lines, push);
  symbols.sort((a, b) => a.line - b.line);
  // Vue & co. run two scanners: drop exact duplicates of the same line
  const seen = new Set();
  const unique = symbols.filter((s) => (seen.has(`${s.line}:${s.kind}`) ? false : seen.add(`${s.line}:${s.kind}`)));
  return { language, total: lines.length, symbols: unique.slice(0, max), truncated: unique.length > max };
}

/** The outline as the model reads it. */
export function formatOutline(path, o) {
  const head = `${path} — ${o.total} line${o.total === 1 ? '' : 's'}${o.language !== 'unknown' ? `, ${o.language}` : ''}, ${o.symbols.length}${o.truncated ? '+' : ''} symbol${o.symbols.length === 1 ? '' : 's'}`;
  if (o.symbols.length === 0) {
    return `${head}\nNo structure could be detected in this file. Read it in chunks: read_file with start_line/end_line, or ranges: [[1,150],[151,300]].`;
  }
  const width = String(o.total).length + 1;
  const body = o.symbols.map((s) => `L${String(s.line).padEnd(width)} ${'  '.repeat(s.depth)}${s.text}`).join('\n');
  return `${head}\n${body}${o.truncated ? '\n… (more symbols not shown)' : ''}\n\nRead one of these with read_file symbol: "Name" -- it returns the whole definition, so there are no line numbers to guess. For anything else use start_line/end_line, or several chunks in one call with ranges: [[a,b],[c,d]].`;
}
