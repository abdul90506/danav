/**
 * Entry point for `node --import ./scripts/ts-support/register.mjs <script>`.
 *
 * Registers the esbuild-backed TypeScript loader so a test file can import the
 * real `.ts` sources under `src/`. See `loader.mjs` for why this exists.
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
