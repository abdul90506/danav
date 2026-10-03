/**
 * Loader that lets Node run the project's TypeScript test targets.
 *
 * Three of the suites (`test:api`, `test:storage`, `test:markdown`) import the
 * real modules under `src/` — they are regression tests for frontend logic, so
 * they must test the shipped source, not a copy. Those modules are `.ts`.
 *
 * They used to run with Node's `--experimental-strip-types`, which only exists
 * on Node 22.6+. On anything older the run died with `node: bad option:
 * --experimental-strip-types` — an error that says nothing about what to do and
 * makes `npm test` look broken on a perfectly good Node 18/20 install.
 *
 * This hook strips types with esbuild instead (already present as a Vite
 * dependency, and declared explicitly in devDependencies), so the suites run on
 * every supported Node version and print the same results.
 *
 * Only `.ts`/`.tsx` files are touched; everything else falls through untouched.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const TS_EXTENSION = /\.(ts|mts|cts|tsx)$/;

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !TS_EXTENSION.test(new URL(url).pathname)) {
    return nextLoad(url, context);
  }

  const source = await readFile(fileURLToPath(url), 'utf8');
  const { code } = await transform(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'node18',
    sourcemap: 'inline',
    // Tests import modules that live under src/ and may reference
    // `import.meta.env` (a Vite-only global) — define it so a module that reads
    // it does not explode when loaded outside the bundler.
    define: { 'import.meta.env.MODE': '"test"' },
  });

  return { format: 'module', source: code, shortCircuit: true };
}
