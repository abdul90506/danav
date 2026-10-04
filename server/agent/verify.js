/**
 * What this project uses to check itself.
 *
 * "Verify your work" is in the prompt as a rule, but a model that does not know
 * what the project can check will either skip the check or invent one — a
 * `node --test` run in a repo with a real test script, or `npm test` in a folder
 * with no package.json at all. Both cost a round trip and teach nobody anything.
 *
 * This reads the few files that say what verification exists (package.json
 * scripts, tsconfig, a Makefile, pytest/cargo/go markers) and returns a short
 * block for the system prompt. It never runs anything and never reads source.
 */

/** A root config file, if it is there and small enough to be a config. */
async function readRoot(workspace, name, maxBytes = 200_000) {
  try {
    const abs = typeof workspace.safePath === 'function' ? await workspace.safePath(name) : await workspace.resolve(name);
    const st = await workspace.stat(abs);
    if (st?.type !== 'file') return null;
    if (Number.isFinite(st.size) && st.size > maxBytes) return null;
    const r = await workspace.readText(abs);
    return r.binary ? null : r.text;
  } catch {
    return null;
  }
}

/** Order a project's own scripts by how much they look like a check. */
const SCRIPT_ORDER = ['test', 'test:suites', 'typecheck', 'lint', 'build'];

/**
 * @returns {Promise<{ lines: string[], commands: string[] }>} empty when the
 *          workspace is new or says nothing about how to check it.
 */
export async function detectChecks(workspace) {
  const commands = [];
  const lines = [];
  const seen = new Set();
  const add = (label, command, note) => {
    const key = `${label}::${command}`;
    if (seen.has(key)) return;
    seen.add(key);
    commands.push(command);
    lines.push(`- \`${command}\` — ${label}${note ? ` (${note})` : ''}`);
  };

  const pkg = await readRoot(workspace, 'package.json');
  if (pkg) {
    let parsed = null;
    try {
      parsed = JSON.parse(pkg);
    } catch {
      /* a broken package.json is the project's problem, not this function's */
    }
    const scripts = parsed?.scripts || {};
    const names = Object.keys(scripts);
    const wanted = [...SCRIPT_ORDER.filter((name) => names.includes(name))];
    // Anything else that names itself a check, so a project with its own naming
    // is still told about (test:api, check:types, …).
    for (const name of names) {
      if (wanted.includes(name)) continue;
      if (/(^|:)(test|check|verify|lint|typecheck|types|build)(:|$)/i.test(name)) wanted.push(name);
    }
    for (const name of wanted.slice(0, 5)) {
      const label = String(scripts[name] || '').trim().slice(0, 90);
      add(`package.json script "${name}"`, name === 'test' ? 'npm test' : `npm run ${name}`, label);
    }
  }

  const tsconfig = await readRoot(workspace, 'tsconfig.json', 40_000);
  if (tsconfig && !commands.some((c) => c.includes('tsc'))) {
    add('TypeScript project — type check before you call a change done', 'npx tsc --noEmit');
  }

  const makefile = (await readRoot(workspace, 'Makefile', 60_000)) || (await readRoot(workspace, 'makefile', 60_000));
  if (makefile) {
    const targets = new Set([...makefile.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1]));
    for (const target of ['test', 'check', 'build', 'lint'].filter((t) => targets.has(t))) {
      add(`Makefile target "${target}"`, `make ${target}`);
    }
  }

  const pyproject = (await readRoot(workspace, 'pyproject.toml', 60_000)) || (await readRoot(workspace, 'setup.cfg', 60_000));
  const requirements = await readRoot(workspace, 'requirements.txt', 60_000);
  if ((pyproject && /pytest|tool\.pytest/i.test(pyproject)) || (requirements && /pytest/i.test(requirements))) {
    add('pytest', 'python3 -m pytest -q');
  }
  /**
   * How much is there to check, and — when the project declares no test script —
   * what the test command probably is.
   *
   * A model that has to guess between `node --test`, `node --test test/`,
   * `npx vitest` and `npx jest` guesses wrong often enough to waste a round trip.
   * The runners are named in the project's own dependencies, and Node has had a
   * built-in runner since 18, so when test files exist and nothing has claimed the
   * job the command is inferred and labelled as inferred.
   */
  let testFiles = 0;
  try {
    for (const glob of ['*.test.*', '*.spec.*', '*_test.*', 'test_*.py']) {
      const search = await workspace.findFiles({ pattern: glob, path: workspace.root, maxResults: 5 });
      testFiles += (search.files || []).length;
    }
  } catch {
    /* counting tests is a courtesy, never a failure */
  }

  const deps = (() => {
    try {
      const parsed = JSON.parse(pkg || '{}');
      return { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    } catch {
      return {};
    }
  })();
  const hasTestCommand = commands.some((c) => /(^|\s)(jest|vitest|mocha|pytest|rspec)\b|(^|\s)test(\s|$)/i.test(c));
  if (testFiles && !hasTestCommand) {
    if (deps.vitest) add('vitest, from your dependencies', 'npx vitest run');
    else if (deps.jest) add('jest, from your dependencies', 'npx jest');
    else if (deps.ava) add('ava, from your dependencies', 'npx ava');
    else if (deps.mocha) add('mocha, from your dependencies', 'npx mocha');
    else if (pkg) add("Node's built-in test runner — no test script is declared, so this is inferred", 'node --test');
    else add('pytest, inferred from test files (if it is installed)', 'python3 -m pytest -q');
  }

  if (await readRoot(workspace, 'Cargo.toml', 60_000)) {
    add('cargo test', 'cargo test');
    add('cargo build', 'cargo build');
  }
  if (await readRoot(workspace, 'go.mod', 60_000)) {
    add('go test', 'go test ./...');
    add('go build', 'go build ./...');
  }

  if (!lines.length) return { lines: [], commands: [] };

  if (testFiles) {
    lines.push(`- Test files exist in this workspace (${testFiles}${testFiles >= 5 ? '+' : ''}) — run the ones that cover what you changed.`);
  }

  return { lines, commands };
}

/** The prompt section, or '' when the workspace has nothing to say about checks. */
export function formatChecksHint(checks) {
  if (!checks?.lines?.length) return '';
  return (
    '# How this project checks itself\n' +
    'Detected from the workspace. Run the relevant one before you call code work done, and fix what it reports ' +
    'instead of describing it as a known issue. **run_checks runs them all in one call** — fastest first, stopping at ' +
    'the first real failure and handing back its error lines — or run one directly with run_command when you only ' +
    'want that one. A new project with no checks of its own is the exception: write the check you can actually run ' +
    '(a small test file, or the app started and its output inspected).\n' +
    checks.lines.join('\n')
  );
}
