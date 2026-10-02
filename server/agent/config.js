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
  /** Sandbox lifetime that is refreshed on activity; it pauses (not dies) after this. */
  sandboxTimeoutMs: () => num('NOVITA_SANDBOX_TIMEOUT_MINUTES', 30) * 60_000,
  maxOutputChars: 30_000,
  maxReadChars: 100_000,
  maxReadLines: 2000,
  maxWriteChars: 2_000_000,
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
