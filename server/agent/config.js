/**
 * Agent configuration: where data lives, where secrets come from, limits, and
 * the request guard for the agent routes.
 *
 * The Novita key is SERVER-SIDE ONLY. It is read from the environment (a
 * gitignored `.env`) or from a gitignored file under server/data, and no route
 * ever returns it — the browser only learns whether one is configured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = () => process.env.DANAV_DATA_DIR || path.join(__dirname, '..', 'data');

export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on unusual filesystems */ }
  }
  return dir;
}

/** tmp-file + rename, so a crash never leaves a half-written JSON file. */
export function atomicWrite(file, contents, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Novita key
// ---------------------------------------------------------------------------

const secretsFile = () => path.join(ensureDataDir(), 'agent-secrets.json');

function readSecrets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getNovitaKey() {
  const fromEnv = (process.env.NOVITA_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return String(readSecrets().novitaApiKey || '').trim();
}

export function novitaKeySource() {
  if ((process.env.NOVITA_API_KEY || '').trim()) return 'env';
  return readSecrets().novitaApiKey ? 'saved' : null;
}

export function saveNovitaKey(key) {
  const secrets = readSecrets();
  secrets.novitaApiKey = String(key).trim();
  atomicWrite(secretsFile(), JSON.stringify(secrets, null, 2), 0o600);
}

export function clearNovitaKey() {
  const secrets = readSecrets();
  delete secrets.novitaApiKey;
  atomicWrite(secretsFile(), JSON.stringify(secrets, null, 2), 0o600);
}

// ---------------------------------------------------------------------------
// Paths & limits
// ---------------------------------------------------------------------------

/** Where new local workspaces are created. Outside the repo on purpose. */
export const workspacesDir = () =>
  path.resolve(process.env.DANAV_WORKSPACES_DIR || path.join(os.homedir(), 'danav-workspaces'));

/** Opt-in: let a local workspace point at any folder, not just the workspaces dir. */
export const allowAnyLocalPath = () => process.env.DANAV_ALLOW_ANY_LOCAL_PATH === '1';

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const limits = {
  /** LLM rounds per run. Each round may run several tools. */
  maxSteps: () => num('DANAV_AGENT_MAX_STEPS', 80),
  /** Hard wall-clock cap for one run. */
  maxRunMs: () => num('DANAV_AGENT_MAX_RUN_MINUTES', 45) * 60_000,
  /** Characters of conversation kept before old tool output is elided. */
  contextChars: () => num('DANAV_AGENT_CONTEXT_CHARS', 420_000),
  /** Default command timeout. */
  commandTimeoutMs: () => num('DANAV_AGENT_COMMAND_TIMEOUT_SECONDS', 120) * 1000,
  maxCommandTimeoutMs: () => num('DANAV_AGENT_MAX_COMMAND_TIMEOUT_SECONDS', 900) * 1000,
  /**
   * Platform-level backstop: Novita itself pauses the sandbox this long after the
   * last activity, even if this server died. It is refreshed on every use, so it
   * only has to outlast a single long tool call — the app-level idle pause below
   * is what normally stops the meter.
   */
  sandboxTimeoutMs: () => num('NOVITA_SANDBOX_TIMEOUT_MINUTES', 15) * 60_000,
  /** No activity in a workspace for this long -> the sandbox is paused. */
  sandboxIdlePauseMs: () => num('DANAV_SANDBOX_IDLE_PAUSE_SECONDS', 180) * 1000,
  /**
   * A finished run is a strong "we are done here" signal, so the clock starts
   * shorter: after this long with nothing else happening the sandbox pauses,
   * even if the general idle window has not elapsed yet.
   */
  sandboxRunGraceMs: () => num('DANAV_SANDBOX_RUN_GRACE_SECONDS', 90) * 1000,
  maxOutputChars: 30_000,
  maxReadChars: 100_000,
  maxReadLines: 2000,
  maxWriteChars: 2_000_000,

  /**
   * How fast a tool call whose body arrived whole is revealed in the chat (see
   * the reveal plan in loop.js). Characters per second, floored and capped by a
   * duration range. The defaults are tuned for a person watching the file being
   * written; the test suite raises them so behavioural tests do not spend
   * seconds of wall clock on an animation.
   */
  revealCharsPerSec: () => num('DANAV_REVEAL_CHARS_PER_SEC', 1100),
  revealMinMs: () => num('DANAV_REVEAL_MIN_MS', 800),
  revealMaxMs: () => num('DANAV_REVEAL_MAX_MS', 2800),
};

// ---------------------------------------------------------------------------
// Request guard for /api/agent/*
// ---------------------------------------------------------------------------
// These routes can run commands and touch files, so they must not be reachable
// from a random web page the user happens to have open:
//   - The Host must be loopback (or explicitly allowed): stops DNS-rebinding.
//   - A custom header is required: a cross-origin page cannot send one without a
//     CORS preflight, and these routes deliberately send no CORS headers.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostRules() {
  return (process.env.DANAV_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (LOOPBACK.has(h) || h.endsWith('.localhost')) return true;
  return hostRules().some((rule) =>
    rule.startsWith('.') ? h === rule.slice(1) || h.endsWith(rule) : h === rule
  );
}

export const AGENT_HEADER = 'x-danav-agent';

export function agentRequestGuard(req, res, next) {
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!isAllowedHostname(hostname)) {
    return res.status(403).json({
      error:
        `Agent routes only answer on localhost by default (got "${hostname}"). ` +
        'To expose them, add the hostname to DANAV_ALLOWED_HOSTS — and put the app behind authentication first.',
    });
  }
  if (req.headers[AGENT_HEADER] !== '1') {
    return res.status(403).json({ error: `Missing ${AGENT_HEADER} header.` });
  }
  next();
}
