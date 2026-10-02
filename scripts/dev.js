import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Dev supervisor.
 *
 * Starts BOTH the Express backend (port 3001) and the Vite dev server (port
 * 5173), waits until the backend is actually accepting connections before
 * starting Vite, and restarts the backend if it crashes.
 *
 * This exists because running `vite` on its own produces a wall of
 * "http proxy error: /api/... ECONNREFUSED" noise — the frontend has nothing to
 * talk to. One command should start a working app.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const BACKEND_PORT = Number(process.env.PORT) || 3001;
const FRONTEND_PORT = Number(process.env.VITE_PORT) || 5173;
// Bind the dev server to all interfaces by default so it is reachable from a
// browser outside the box (e.g. a sandboxed preview). Override with VITE_HOST.
const FRONTEND_HOST = process.env.VITE_HOST || '0.0.0.0';
const MAX_BACKEND_RESTARTS = 5;

let backend = null;
let vite = null;
let shuttingDown = false;
let backendRestarts = 0;

const log = (msg) => console.log(`[dev] ${msg}`);

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(600, () => finish(false));
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down...');
  for (const child of [vite, backend]) {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (e) {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(code), 150);
}

async function startBackend() {
  if (await isPortOpen(BACKEND_PORT)) {
    log(`port ${BACKEND_PORT} is already in use — reusing the running backend.`);
    log('(if you just changed server/index.js, stop that process and restart.)');
    return;
  }

  log(`starting backend on http://localhost:${BACKEND_PORT}`);
  backend = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  });

  backend.on('exit', (code, signal) => {
    backend = null;
    if (shuttingDown) return;

    if (backendRestarts >= MAX_BACKEND_RESTARTS) {
      console.error(
        `\n[dev] Backend exited ${MAX_BACKEND_RESTARTS} times (code ${code}). Giving up.\n` +
          `[dev] Fix the error above, then run: npm run dev\n`
      );
      shutdown(1);
      return;
    }

    backendRestarts++;
    const delay = Math.min(1000 * backendRestarts, 5000);
    console.error(
      `\n[dev] Backend stopped unexpectedly (code ${code}${signal ? `, ${signal}` : ''}). ` +
        `Restarting in ${delay / 1000}s... (${backendRestarts}/${MAX_BACKEND_RESTARTS})\n`
    );
    setTimeout(() => {
      if (!shuttingDown) startBackend();
    }, delay);
  });
}

async function startVite() {
  log(`starting frontend on http://${FRONTEND_HOST}:${FRONTEND_PORT}`);
  vite = spawn(
    process.execPath,
    [
      path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'),
      // vite.config.sandbox.ts = base config + host 0.0.0.0 + allowedHosts:true,
      // so the generated preview hostname (*.e2b.app) is accepted instead of
      // "Blocked request. This host is not allowed."
      '--config', 'vite.config.sandbox.ts',
      '--host', FRONTEND_HOST,
      '--port', String(FRONTEND_PORT),
    ],
    { cwd: rootDir, stdio: 'inherit' }
  );

  vite.on('exit', (code) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`\n[dev] Frontend failed to start (exit code ${code}).`);
      console.error(
        `[dev] If the error above says "Port ${FRONTEND_PORT} is already in use", ` +
          `another dev server is still running — press Ctrl+C there, then run "npm run dev" again.\n`
      );
    }
    shutdown(code ?? 0);
  });
}

async function main() {
  console.log('');
  console.log('  Danav AI Chat — starting backend + frontend');
  console.log('  ------------------------------------------------');

  await startBackend();

  const backendReady = await waitForPort(BACKEND_PORT);
  if (backendReady) {
    log(`backend is ready on port ${BACKEND_PORT}`);
  } else {
    console.error(
      `\n[dev] Backend did not become reachable on port ${BACKEND_PORT}.\n` +
        `[dev] Vite would only show "http proxy error ... ECONNREFUSED" — starting it anyway.\n`
    );
  }

  if (await isPortOpen(FRONTEND_PORT)) {
    console.error(
      `\n[dev] Port ${FRONTEND_PORT} is already in use by another process.\n` +
        `[dev] Close the other dev server (Ctrl+C) before running "npm run dev",\n` +
        `[dev] or start on a different port: VITE_PORT=5273 npm run dev\n`
    );
    shutdown(1);
    return;
  }

  await startVite();

  console.log('');
  log(`open http://localhost:${FRONTEND_PORT}  (API proxied to :${BACKEND_PORT})`);
  console.log('');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (!shuttingDown) shutdown(0);
});

main().catch((err) => {
  console.error('[dev] failed to start:', err);
  shutdown(1);
});
