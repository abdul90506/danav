import dotenv from 'dotenv';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { createStreamSplitter } from './streamSplitter.js';
import { normalizeToolExecutionsForDisk } from './toolTrail.js';
import { fetchViaCurl } from './curlFetch.js';
import { assertPublicResultUrl, fetchPublicUrl, isCloudMetadataUrl, UrlRefusedError } from './publicFetch.js';
import { registerAgentRoutes, _activeRuns } from './agent/routes.js';
import { startIdlePauseSweeper } from './agent/idlePause.js';
import { normalizeAgentBlockForDisk } from './agent/persist.js';
import { modelForProvider, normalizeThinkingLevel, thinkingParams } from './agent/thinking.js';
import { mergeSettingsPatch, publicSettings, resolveConfiguredProvider } from './settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keys and options live in <repo>/.env (gitignored) — found no matter where the server is started from.
// Variables already set in the shell win over the file.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

function previewTokenMatches(req) {
  const expected = Buffer.from(String(process.env.DANAV_PREVIEW_TOKEN || ''));
  if (!expected.length) return true;
  const supplied = Buffer.from(String(req.headers['x-danav-preview-token'] || ''));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

// The UI calls its APIs through same-origin relative URLs (or the Vite proxy).
// Never grant cross-origin access to settings, provider credentials or Agent.
const openCors = cors();
const credentialRoutes = new Set([
  '/api/settings', '/api/chat', '/api/chat/title', '/api/providers/test',
  '/api/providers/models', '/api/preview-auth/check',
  // Same-origin only: the UI never calls this (the chat's tools do, in-process),
  // and with CORS open any web page could use this server as a free fetch/search
  // proxy — making requests from the user's network on someone else's behalf.
  '/api/search',
]);
app.use((req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  const protectedRoute = req.path.toLowerCase().startsWith('/api/agent') || credentialRoutes.has(normalizedPath);
  // The public preview uses Vite on a single origin and an access token for API
  // calls, so don't add permissive CORS headers to ANY API in that mode.
  if (process.env.DANAV_PREVIEW_TOKEN && normalizedPath.startsWith('/api/')) return next();
  return protectedRoute ? next() : openCors(req, res, next);
});
/**
 * Compress responses — except streams.
 *
 * The built frontend is ~250 kB of JS and ~160 kB of markdown, and this server
 * may well be the only thing in front of the browser (no nginx to gzip for it).
 * Server-sent events must never be compressed or buffered: the reply has to
 * arrive token by token, and a buffering compressor would hold it back.
 */
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader('Content-Type') || '');
      if (type === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  })
);
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  if (!process.env.DANAV_PREVIEW_TOKEN || !normalizedPath.startsWith('/api/') || normalizedPath === '/api/preview-auth/check') return next();
  if (!previewTokenMatches(req)) {
    return res.status(401).json({ success: false, error: 'Preview access code required.', code: 'preview_auth_required' });
  }
  next();
});

/**
 * Never let a missing/!object body crash a handler.
 *
 * `express.json()` sets `req.body` to `null` for a literal `null` payload and
 * leaves it `undefined` when there is no body at all. Destructuring that
 * (`const { tool } = req.body`) throws a TypeError before the handler's own
 * try/catch, which — because the handler is `async` — becomes an unhandled
 * rejection and the request NEVER gets a response. Normalising here removes the
 * whole class.
 */
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});

/**
 * Make every route handler failure-safe.
 *
 * Express 4 does not catch rejected promises from `async` handlers, and it does
 * not catch synchronous throws either — both leave the socket open with no
 * response, so the client waits until its own timeout while the UI spins. This
 * wraps each handler so a throw OR a rejection is forwarded to the error
 * middleware below, which always answers.
 *
 * Applied before any route is registered, so it covers every route including
 * ones added later.
 */
for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
  const register = app[method].bind(app);
  app[method] = (routePath, ...handlers) =>
    register(
      routePath,
      ...handlers.map((handler) => {
        // Leave error middleware (arity 4) and non-functions alone.
        if (typeof handler !== 'function' || handler.length >= 4) return handler;
        return (req, res, next) => {
          try {
            const out = handler(req, res, next);
            if (out && typeof out.then === 'function') out.catch(next);
          } catch (err) {
            next(err);
          }
        };
      })
    );
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * fetch() with a hard timeout.
 *
 * Every external call the search tools make (search engines, scraped pages, APIs)
 * must be bounded. Without this, one unresponsive upstream hangs the whole
 * request forever and the user just sees a spinner.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Collapse whitespace and strip tags from a scraped HTML fragment. */
function textFromHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect anti-bot / security interstitial pages.
 *
 * Many sites answer a plain fetch with a Cloudflare "Just a moment…" challenge,
 * a captcha wall, or a 403 "Access Denied" page instead of real content. Those
 * pages are useless (and often only ~2KB of boilerplate), so we must recognise
 * them and fall back to a reader proxy rather than feeding garbage to the model.
 */
function looksLikeBotWall(status, bodyText, headers) {
  const text = String(bodyText || '').toLowerCase();
  const server = (headers?.get?.('server') || '').toLowerCase();

  // Hard HTTP signals — these really are refusals.
  if (status === 403 || status === 429 || status === 503) return true;

  // Strong markers: phrases that only appear on an interstitial/challenge page.
  const strongMarkers = [
    'just a moment',
    'attention required',
    'cf-browser-verification',
    'checking your browser',
    'cf-challenge',
    'cf_chl_opt',
    'challenge-platform',
    'enable javascript and cookies',
    'verify you are human',
    'are you a robot',
    'unusual traffic',
    'ddos protection',
  ];
  if (strongMarkers.some((m) => text.includes(m))) return true;

  // Weak markers: only meaningful on a short page (a long article that merely
  // mentions "captcha" once is real content and must not be discarded).
  const weakMarkers = ['access denied', 'request blocked', 'captcha'];
  if (text.length < 6000 && weakMarkers.some((m) => text.includes(m))) return true;

  // A "server: cloudflare" header alone means NOTHING — a huge share of normal
  // sites sit behind Cloudflare. Only treat it as a wall when the (short) body
  // also contains Cloudflare challenge plumbing. Without this check, tiny legit
  // pages like example.com were wrongly reported as blocked.
  if (server.includes('cloudflare') && text.length < 1500 && /cf[-_]|challenge|cloudflare/i.test(text)) {
    return true;
  }

  return false;
}

/** Turn raw HTML into readable text (drops scripts, styles, chrome). */
function htmlToReadableText(html) {
  let body = String(html || '');
  let title = '';
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = textFromHtml(titleMatch[1]);

  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Preserve paragraph/heading breaks so the text does not become one long line.
  body = body
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  return { title, text: textFromHtml(body) };
}

/**
 * Bing wraps every organic result in a tracking redirect:
 *   https://www.bing.com/ck/a?...&u=a1<base64url-of-real-url>&ntb=1
 * Decode it back to the real destination, otherwise the result is useless
 * (and gets filtered out as a bing.com link).
 */
function decodeBingUrl(url) {
  try {
    const cleaned = String(url).replace(/&amp;/g, '&');
    const u = new URL(cleaned).searchParams.get('u');
    if (u && u.startsWith('a1')) {
      const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf-8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch (e) {}
  return String(url).replace(/&amp;/g, '&');
}

/**
 * Reader-proxy fallback for pages that block direct fetching.
 * r.jina.ai renders the page server-side and returns clean text/markdown.
 */
/**
 * Reader proxies that render a page server-side and hand back clean text.
 *
 * Sites behind a bot wall often 403 a plain fetch but serve these fine, so we
 * cascade through them instead of giving up after a single provider hiccup.
 */
const READER_PROXIES = [
  { name: 'r.jina.ai', build: (u) => `https://r.jina.ai/${u}`, html: false },
  {
    name: 'codetabs',
    build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    html: true,
  },
  {
    name: 'allorigins',
    build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    html: true,
  },
];

async function fetchViaReaderProxy(targetUrl, timeoutMs = 10000) {
  for (const proxy of READER_PROXIES) {
    try {
      const res = await fetchWithTimeout(
        proxy.build(targetUrl),
        {
          headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/plain, text/html, text/markdown;q=0.9, */*;q=0.8',
            ...(proxy.html ? {} : { 'X-Return-Format': 'markdown' }),
          },
        },
        timeoutMs
      );
      if (!res.ok) continue;
      const raw = await res.text();
      if (!raw || raw.length < 200) continue;
      if (looksLikeBotWall(200, raw, res.headers)) continue;

      const text = proxy.html ? htmlToReadableText(raw).text : raw;
      if (!text || text.length < 200) continue;
      return text.slice(0, 12000);
    } catch (e) {
      // Try the next proxy.
    }
  }
  return null;
}

// Persistent Settings on Server Disk
const DATA_DIR = process.env.DANAV_DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
// The settings file can contain provider API keys. Restrict this store to the
// account running Danav on POSIX systems; Windows uses its normal ACL model.
if (process.platform !== 'win32') {
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* best effort on unusual filesystems */ }
  if (fs.existsSync(SETTINGS_FILE)) {
    try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* best effort on unusual filesystems */ }
  }
}

/**
 * Write a file atomically: temp file, flush, then rename over the target.
 *
 * A plain `writeFileSync` truncates the target before writing, so a crash, a
 * full disk, or a killed process between those two steps leaves a half-written
 * JSON file. The read side treats an unparseable file as "empty" and the next
 * save persists that emptiness — so the user's conversations or memory are
 * gone for good, silently. `rename` is atomic within a filesystem, so a reader
 * sees either the complete old file or the complete new one, never a partial.
 */
function atomicWriteFileSync(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contents, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

const DEFAULT_SETTINGS = {
  providers: [
    {
      id: 'provider-gemini',
      name: 'gemmni',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: process.env.GEMINI_API_KEY || '',
      apiType: 'openai',
      isCustom: true,
      enabled: true,
      models: [
        { id: 'models/gemini-3.5-flash', name: 'models/gemini-3.5-flash', providerId: 'provider-gemini', supportsThinking: true },
        { id: 'models/gemini-3.1-flash-lite', name: 'models/gemini-3.1-flash-lite', providerId: 'provider-gemini', supportsThinking: true },
        { id: 'models/gemini-3.5-flash-lite', name: 'models/gemini-3.5-flash-lite', providerId: 'provider-gemini', supportsThinking: true },
        { id: 'models/gemini-3.6-flash', name: 'models/gemini-3.6-flash', providerId: 'provider-gemini', supportsThinking: true },
        { id: 'models/gemma-4-26b-a4b-it', name: 'models/gemma-4-26b-a4b-it', providerId: 'provider-gemini', supportsThinking: false },
        { id: 'models/gemma-4-31b-it', name: 'models/gemma-4-31b-it', providerId: 'provider-gemini', supportsThinking: false },
      ],
    },
    {
      id: 'provider-vyce',
      name: 'Vyce AI',
      baseUrl: 'https://vyceai.com/v1',
      apiKey: process.env.VYCE_API_KEY || '',
      apiType: 'openai',
      isCustom: false,
      enabled: true,
      models: [
        { id: 'agnes-3.0-flash', name: 'agnes-3.0-flash', providerId: 'provider-vyce', supportsThinking: false },
        { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', providerId: 'provider-vyce', supportsThinking: true },
        { id: 'qwen3.8-flash', name: 'qwen3.8-flash', providerId: 'provider-vyce', supportsThinking: false },
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerId: 'provider-vyce', supportsThinking: false },
        { id: 'deepseek-v4.1', name: 'deepseek-v4.1', providerId: 'provider-vyce', supportsThinking: true },
        { id: 'deepseek-v4-flash-lr', name: 'deepseek-v4-flash-lr', providerId: 'provider-vyce', supportsThinking: false },
        { id: 'grok-imagine-2', name: 'grok-imagine-2', providerId: 'provider-vyce', supportsThinking: false },
      ],
    },
  ],
  theme: 'light',
  lastSelectedProviderId: 'provider-gemini',
  lastSelectedModelId: 'models/gemini-3.5-flash',
};

function readSettingsFromDisk() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      // A file that parses to null/array/string is not a settings object; fall
      // through to defaults WITHOUT overwriting the file.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      console.error('Settings file is not a settings object — using defaults without overwriting it.');
    } catch (err) {
      // The file exists but could not be read/parsed. Overwriting it here would
      // silently destroy the user's providers and API keys, so leave it on disk
      // and run on defaults; the user can repair or delete it.
      console.error('Error reading settings file (left untouched):', err);
    }
    return DEFAULT_SETTINGS;
  }
  // Only a genuinely missing file is initialised with defaults.
  writeSettingsToDisk(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

function writeSettingsToDisk(settings) {
  try {
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing settings file:', err);
    return false;
  }
}

// Safe access-code check for the isolated public preview. It never returns the configured token.
app.get('/api/preview-auth/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const required = Boolean(process.env.DANAV_PREVIEW_TOKEN);
  const authenticated = !required || previewTokenMatches(req);
  return res.status(authenticated ? 200 : 401).json({ required, authenticated });
});

// Settings API Endpoints. Provider keys stay on disk and are never reflected to the browser.
app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const settings = readSettingsFromDisk();
  return res.json({ success: true, settings: publicSettings(settings) });
});

app.post('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ success: false, error: 'Settings must be sent as a JSON object.' });
  }
  if (Object.hasOwn(req.body, 'providers')) {
    if (!Array.isArray(req.body.providers)) {
      return res.status(400).json({ success: false, error: 'Providers must be an array.' });
    }
    // Refuse rather than silently storing something the UI can never open. This
    // is also what protects a stored API key: a provider list that is replaced by
    // junk entries takes its credentials with it.
    const bad = req.body.providers.findIndex(
      (provider) =>
        !provider ||
        typeof provider !== 'object' ||
        Array.isArray(provider) ||
        !String(provider.id ?? '').trim()
    );
    if (bad !== -1) {
      return res.status(400).json({
        success: false,
        error: `Provider ${bad + 1} is not valid (each provider needs an "id"). Nothing was saved.`,
      });
    }
  }

  const current = readSettingsFromDisk();
  const updated = mergeSettingsPatch(current, req.body);
  updated.updatedAt = Date.now();
  const ok = writeSettingsToDisk(updated);
  if (ok) {
    return res.json({ success: true, settings: publicSettings(updated) });
  }
  return res.status(500).json({ success: false, error: 'Could not save settings to backend' });
});

// Conversations / Chat History Persistence on Backend Disk
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
// Safety copy of the store taken before it is allowed to shrink.
const CONVERSATIONS_BACKUP_FILE = path.join(DATA_DIR, 'conversations.backup.json');

function countConversationsInFile(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed.conversations) ? parsed.conversations.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Total stored messages, across all conversations.
 *
 * The conversation COUNT alone is not enough to detect a lossy save: a stale
 * tab that still holds the same five chats but with older, shorter histories
 * overwrites newer data while the count stays identical. Message count catches
 * that case too.
 */
function countMessagesInFile(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed.conversations) ? parsed.conversations : [];
    let total = 0;
    for (const c of list) total += Array.isArray(c?.messages) ? c.messages.length : 0;
    return total;
  } catch {
    return 0;
  }
}

/**
 * IMPORTANT: this decides what gets thrown away when a conversation is written
 * to disk. It must stay *very* conservative — an over-eager rule here silently
 * deletes real assistant answers on save/reload, which is exactly the "text
 * disappeared from my chat" bug. Only unambiguous machine artifacts are dropped:
 * echoed tool-result envelopes, which are never something the user wrote.
 */
const isDroppableArtifact = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (/^\[Tool Result:[^\]]*\]/i.test(trimmed)) return true;
  if (/^Tool Execution Results:/i.test(trimmed)) return true;
  return false;
};

/**
 * Keep the web-tool trail on disk, but in a bounded and settled form.
 * See `server/toolTrail.js` for why a `running` entry must not survive a reload.
 */
function cleanConversationsForDisk(conversations) {
  if (!Array.isArray(conversations)) return [];
  // Anything that is not an object cannot be a conversation; dropping it here
  // keeps one malformed entry from failing the whole save (destructuring `null`
  // threw, and the user's write was reported as a 500).
  const list = conversations.filter((conv) => conv && typeof conv === 'object' && !Array.isArray(conv));
  const cleanText = (str) => {
    if (!str || typeof str !== 'string') return str;
    return str
      .replace(/<\/?(?:update_progress|update_task|progress|task_complete|task_status)[^>]*>/gi, '')
      .replace(/<[a-z0-9_-]*(?:progress|task|update)[^>]*\/?>/gi, '')
      .replace(/\[Tool Result:[^\]]*\][\s\S]*?(?=\n\n|$)/gi, '')
      .trim();
  };

  return list.map((conv) => {
    // Chats created before agent mode was removed still carry `mode`,
    // `workspace` and `summary`. Nothing reads them any more, so drop them
    // instead of carrying dead keys in the store forever.
    const { mode, workspace, summary, ...restConv } = conv;

    return {
      ...restConv,
      messages: (Array.isArray(conv.messages) ? conv.messages : []).filter((msg) => msg && typeof msg === 'object').map((msg) => {
        let cleanedContent = cleanText(msg.content);
        if (isDroppableArtifact(cleanedContent)) {
          cleanedContent = '';
        }

        const normalizedBlocks =
          Array.isArray(msg.blocks) && msg.blocks.length > 0
            ? msg.blocks
                .filter(
                  (b) =>
                    b &&
                    typeof b === 'object' &&
                    (b.type === 'tool' || b.type === 'thinking' || b.type === 'text' || b.type === 'action')
                )
                .map((b) => {
                  // Agent turns: the model's narration and each action it took.
                  if (b.type === 'text' || b.type === 'action') return normalizeAgentBlockForDisk(b);
                  if (b.type === 'tool' && b.tool) {
                    const normList = normalizeToolExecutionsForDisk([b.tool]);
                    return {
                      id: String(b.id || `tool-${Math.random().toString(36).slice(2, 8)}`),
                      type: 'tool',
                      tool: normList ? normList[0] : b.tool,
                    };
                  }
                  return {
                    id: String(b.id || `think-${Math.random().toString(36).slice(2, 8)}`),
                    type: 'thinking',
                    content: typeof b.content === 'string' ? b.content.slice(0, 50000) : '',
                    duration: typeof b.duration === 'number' ? b.duration : undefined,
                    isStillThinking: false,
                  };
                })
                .filter(Boolean)
            : undefined;

        const { blocks, ...rest } = msg;

        return {
          ...rest,
          ...(normalizedBlocks ? { blocks: normalizedBlocks } : {}),
          toolExecutions: normalizeToolExecutionsForDisk(msg.toolExecutions),
          content: cleanedContent,
          // A message saved mid-stream must not come back claiming it is still
          // generating: that is what left a spinner running forever after a reload.
          isGenerating: false,
        };
      }),
    };
  });
}

function readConversationsFromDisk() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const content = fs.readFileSync(CONVERSATIONS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      const rawList = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      return {
        conversations: cleanConversationsForDisk(rawList),
        activeChatId: parsed.activeChatId || null,
      };
    }
  } catch (err) {
    console.error('Error reading conversations file:', err);
  }
  return { conversations: [], activeChatId: null };
}

/**
 * @param {object} data
 * @param {object} [options]
 * @param {boolean} [options.keepBackup] Restoring FROM the backup must not
 *   overwrite that backup with the state being replaced — otherwise "Restore
 *   older backup" would be a one-way door with no copy left to go back to.
 */
function writeConversationsToDisk(data, { keepBackup = false } = {}) {
  try {
    const toSave = {
      ...data,
      conversations: cleanConversationsForDisk(data.conversations),
    };

    // POST /api/conversations REPLACES the whole store, so a single bad payload
    // — a stale tab, or a test that saves a one-conversation fixture — wipes
    // every chat the user has. Before the store is allowed to SHRINK, keep the
    // larger previous version. The backup never shrinks itself, so it always
    // holds the most complete recent state and one accident is always undoable.
    //
    // Shrinking is measured on BOTH conversations and total messages: a stale
    // tab can save the same number of chats while dropping most of the history,
    // which the conversation count alone would not notice.
    try {
      if (!keepBackup) {
        const previousCount = countConversationsInFile(CONVERSATIONS_FILE);
        const nextCount = toSave.conversations.length;
        const previousMessages = countMessagesInFile(CONVERSATIONS_FILE);
        const nextMessages = toSave.conversations.reduce(
          (sum, c) => sum + (Array.isArray(c?.messages) ? c.messages.length : 0),
          0
        );
        const shrank = previousCount > nextCount || previousMessages > nextMessages;
        if (shrank && previousCount >= countConversationsInFile(CONVERSATIONS_BACKUP_FILE)) {
          atomicWriteFileSync(CONVERSATIONS_BACKUP_FILE, fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
          console.warn(
            `[conversations] store shrank (${previousCount} chats/${previousMessages} msgs -> ` +
              `${nextCount} chats/${nextMessages} msgs); previous state saved to ` +
              `${path.basename(CONVERSATIONS_BACKUP_FILE)}`
          );
        }
      }
    } catch {
      /* a missing or unreadable backup must never block a legitimate save */
    }

    atomicWriteFileSync(CONVERSATIONS_FILE, JSON.stringify(toSave, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing conversations file:', err);
    return false;
  }
}

app.get('/api/conversations', (req, res) => {
  const data = readConversationsFromDisk();
  return res.json({ success: true, ...data });
});

app.post('/api/conversations', (req, res) => {
  const { conversations, activeChatId } = req.body;
  if (!Array.isArray(conversations)) {
    return res.status(400).json({ success: false, error: 'Conversations array is required' });
  }
  const ok = writeConversationsToDisk({
    conversations,
    activeChatId: activeChatId || null,
    updatedAt: Date.now(),
  });
  if (ok) {
    return res.json({ success: true });
  }
  return res.status(500).json({ success: false, error: 'Could not save conversations to backend' });
});

// The safety copy taken when the store shrank. Lets an accidental wipe be undone
// without hand-editing JSON on disk.
app.get('/api/conversations/backup', (req, res) => {
  try {
    if (!fs.existsSync(CONVERSATIONS_BACKUP_FILE)) {
      return res.json({ success: false, error: 'No backup available' });
    }
    const parsed = JSON.parse(fs.readFileSync(CONVERSATIONS_BACKUP_FILE, 'utf-8'));
    return res.json({
      success: true,
      conversations: parsed.conversations || [],
      activeChatId: parsed.activeChatId || null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.post('/api/conversations/restore', (req, res) => {
  try {
    if (!fs.existsSync(CONVERSATIONS_BACKUP_FILE)) {
      return res.status(404).json({ success: false, error: 'No backup available to restore' });
    }
    const parsed = JSON.parse(fs.readFileSync(CONVERSATIONS_BACKUP_FILE, 'utf-8'));
    const conversations = parsed.conversations || [];
    // keepBackup: the copy being restored must survive the restore, so the action
    // stays repeatable instead of destroying the only fallback on use.
    if (!writeConversationsToDisk({ conversations, activeChatId: parsed.activeChatId || null }, { keepBackup: true })) {
      return res.status(500).json({ success: false, error: 'Could not restore conversations' });
    }
    return res.json({ success: true, restored: conversations.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// Ask the active model for a short chat title.
app.post('/api/chat/title', async (req, res) => {
  const { provider: suppliedProvider, model, message } = req.body || {};
  const provider = providerWithStoredCredentials(suppliedProvider);
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (metadataUrlRefusal(provider)) {
    // Falls back to the local title rather than reporting an error: naming a chat
    // is not worth failing a request over.
    return res.json({ title: fallbackTitle(message) });
  }

  function fallbackTitle(text) {
    const cleaned = text.trim().replace(/^["']|["']$/g, '').replace(/[\r\n]+/g, ' ');
    const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
    const capitalized = words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    return capitalized || 'New Chat';
  }

  try {
    const baseUrl = normalizeBaseUrl(provider?.baseUrl);
    if (!baseUrl) {
      return res.json({ title: fallbackTitle(message) });
    }

    const endpoint = `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey.trim()}`;
    }

    const promptText = `Generate a very short, clean 2 to 4 word title in Title Case representing the topic of this user prompt. Do not use quotes, punctuation, or explanations. Respond with ONLY the title.\n\nPrompt: "${message.slice(0, 300)}"`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'models/gemini-3.5-flash',
        messages: [{ role: 'user', content: promptText }],
        stream: false,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (upstream.ok) {
      const data = await upstream.json();
      let rawTitle = data.choices?.[0]?.message?.content || '';
      // Strip any reasoning tags or formatting
      rawTitle = rawTitle
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/["'*#_`]/g, '')
        .replace(/^Title:\s*/i, '')
        .trim();

      if (rawTitle && rawTitle.length > 0 && rawTitle.length < 50) {
        return res.json({ title: rawTitle });
      }
    }
  } catch (err) {
    console.error('AI chat title generation error:', err.message);
  }

  return res.json({ title: fallbackTitle(message) });
});

// Helper: Normalize URL
function normalizeBaseUrl(url) {
  if (url === undefined || url === null) return '';
  // Coerce instead of throwing: `url.trim is not a function` was a 500 when a
  // number reached here from a settings payload.
  const cleaned = String(url).trim().replace(/\/+$/, '');
  return cleaned;
}

/**
 * Is this a Base URL the server can actually call?
 *
 * A provider endpoint is fetched as `${baseUrl}/chat/completions`, so anything
 * that is not http(s) became "Failed to parse URL from not a url/chat/
 * completions" — a 500 that says nothing about the real mistake.
 */
function baseUrlProblem(rawUrl) {
  const value = normalizeBaseUrl(rawUrl);
  if (!value) return 'The provider has no Base URL. Add one in Settings.';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `The provider Base URL must start with http:// or https:// (got "${value.slice(0, 60)}").`;
    }
  } catch {
    return `"${value.slice(0, 60)}" is not a valid provider Base URL. Use the full address, e.g. https://api.openai.com/v1.`;
  }
  return null;
}

/**
 * A provider Base URL comes from the browser, and the server then calls it and
 * streams the answer back — so it must never be aimed at a cloud metadata
 * service, which would hand over the host's credentials as the "model reply".
 * Only that one address class is refused: a local Ollama or a LAN gateway is a
 * real setup and stays allowed (see server/publicFetch.js).
 */
function metadataUrlRefusal(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (!isCloudMetadataUrl(provider.baseUrl)) return null;
  return (
    'That Base URL points at a cloud metadata address ("' +
    String(provider.baseUrl).slice(0, 80) +
    '"), which this app will not call. Use your provider\'s real API endpoint.'
  );
}

function providerWithStoredCredentials(provider) {
  return resolveConfiguredProvider(provider, readSettingsFromDisk());
}

// Test Provider Connection
app.post('/api/providers/test', async (req, res) => {
  const resolved = providerWithStoredCredentials(req.body || {});
  const { baseUrl, apiKey, apiType } = resolved;

  const refusal = metadataUrlRefusal(resolved);
  if (refusal) return res.status(400).json({ success: false, error: refusal });

  if (apiType === 'mock') {
    return res.json({ success: true, message: 'Built-in Demo provider is ready.' });
  }

  const urlProblem = baseUrlProblem(baseUrl);
  if (urlProblem) {
    return res.status(400).json({ success: false, error: urlProblem });
  }

  const cleanUrl = normalizeBaseUrl(baseUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let testEndpoint = `${cleanUrl}/models`;
    let headers = {
      'Accept': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    if (apiType === 'ollama') {
      testEndpoint = `${cleanUrl}/api/tags`;
    }

    const response = await fetch(testEndpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      return res.json({ success: true, message: `Connected successfully (HTTP ${response.status})` });
    }

    const errorText = await response.text();
    let msg = `Provider returned HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.error?.message) {
        msg = parsed.error.message;
      } else if (parsed.message) {
        msg = parsed.message;
      }
    } catch {
      if (errorText && errorText.length < 150) {
        msg = errorText;
      }
    }

    if (response.status === 401) {
      msg = 'Invalid API key or unauthorized access (HTTP 401)';
    } else if (response.status === 404) {
      msg = 'Models endpoint not found (HTTP 404). Check the Base URL format.';
    }

    return res.status(response.status).json({ success: false, error: msg });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(408).json({ success: false, error: 'Connection timed out after 10 seconds. Check URL or firewall.' });
    }
    return res.status(500).json({
      success: false,
      error: `Network error: ${err.message || 'Could not connect to provider'}`,
    });
  }
});

/**
 * Does the provider itself say this model can reason?
 *
 * Returns true / false when the catalogue declares its capabilities, and null
 * when it says nothing either way. Modern OpenAI-compatible catalogues (Novita,
 * OpenRouter, Groq) do declare them — `features: ["function-calling",
 * "reasoning"]`, `capabilities`, `tags` — and that answer beats guessing from
 * the name: "zai-org/glm-5.3", "minimax/minimax-m3" or "moonshotai/kimi-k3"
 * tell a name heuristic nothing, and the user then loses the Thinking control
 * (and the Reasoning badge in the picker) for a model that has it.
 */
function declaredReasoningSupport(model) {
  if (!model || typeof model !== 'object') return null;
  const declared = [];
  for (const key of ['features', 'capabilities', 'tags']) {
    const value = model[key];
    if (Array.isArray(value)) declared.push(...value.map(String));
    else if (typeof value === 'string') declared.push(value);
  }
  if (declared.length === 0) return null;
  return /reasoning|thinking|chain[-_ ]?of[-_ ]?thought/i.test(declared.join(' ')) ? true : null;
}

// Fetch Models
app.post('/api/providers/models', async (req, res) => {
  const resolved = providerWithStoredCredentials(req.body || {});
  const { baseUrl, apiKey, apiType } = resolved;

  const refusal = metadataUrlRefusal(resolved);
  if (refusal) return res.status(400).json({ success: false, error: refusal });

  if (apiType === 'mock') {
    return res.json({
      success: true,
      models: [
        {
          id: 'demo-assistant-v2',
          name: 'Demo Assistant (Fast & Clean)',
          supportsThinking: false,
          description: 'Responsive assistant with instant markdown & code generation',
        },
        {
          id: 'demo-reasoning-pro',
          name: 'Demo Reasoning Pro (Supports Thinking)',
          supportsThinking: true,
          description: 'Simulates deep chain-of-thought reasoning with level controls',
        },
      ],
    });
  }

  if (!baseUrl) {
    return res.status(400).json({ success: false, error: 'Base URL is required' });
  }

  const urlProblem = baseUrlProblem(baseUrl);
  if (urlProblem) {
    return res.status(400).json({ success: false, error: urlProblem });
  }

  const cleanUrl = normalizeBaseUrl(baseUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let modelsEndpoint = `${cleanUrl}/models`;
    let headers = {
      'Accept': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    if (apiType === 'ollama') {
      modelsEndpoint = `${cleanUrl}/api/tags`;
    }

    const response = await fetch(modelsEndpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `Failed to fetch models (HTTP ${response.status})`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) errMsg = parsed.error.message;
      } catch {}
      return res.status(response.status).json({ success: false, error: errMsg });
    }

    const data = await response.json();
    let modelList = [];

    if (apiType === 'ollama' && Array.isArray(data.models)) {
      modelList = data.models.map((m) => {
        const id = m.name || m.model;
        const lower = id.toLowerCase();
        return {
          id,
          name: id,
          supportsThinking:
            lower.includes('deepseek-r1') ||
            lower.includes('think') ||
            lower.includes('qwq') ||
            lower.includes('reason'),
        };
      });
    } else if (Array.isArray(data.data)) {
      modelList = data.data.map((m) => {
        const id = String(m.id ?? m.name ?? '');
        const lower = id.toLowerCase();
        const byName =
          lower.includes('gemini-2.5') ||
          lower.includes('gemini-3') ||
          lower.includes('o1') ||
          lower.includes('o3') ||
          lower.includes('reason') ||
          lower.includes('r1') ||
          lower.includes('thinking') ||
          lower.includes('claude-3-7') ||
          lower.includes('qwq') ||
          lower.includes('glm-5') ||
          lower.includes('deepseek-v4') ||
          lower.includes('kimi-k2') ||
          lower.includes('kimi-k3') ||
          lower.includes('minimax-m');

        const description = typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim() : '';
        return {
          id,
          name: m.name || m.display_name || id,
          // Only ever upgraded by the declared capabilities, never downgraded:
          // a provider that omits `features` must not lose its name match.
          supportsThinking: Boolean(declaredReasoningSupport(m)) || byName,
          ...(description ? { description: description.slice(0, 240) } : {}),
        };
      });
    } else if (Array.isArray(data)) {
      modelList = data.map((item) => {
        const id = typeof item === 'string' ? item : item.id || item.name;
        return {
          id,
          name: id,
          supportsThinking: false,
        };
      });
    } else {
      return res.status(500).json({ success: false, error: 'Unexpected models response format' });
    }

    // Sort alphabetically
    modelList.sort((a, b) => a.id.localeCompare(b.id));

    return res.json({ success: true, models: modelList });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(408).json({ success: false, error: 'Fetch models timed out after 12 seconds' });
    }
    // A provider the server cannot reach is a bad-gateway problem, not a bug in
    // this app — and the message should name the address that failed.
    return res.status(502).json({
      success: false,
      error: `Could not reach ${cleanUrl}/models: ${err.message || 'network error'}. Check the Base URL and that the provider is online.`,
    });
  }
});

// Helper for Mock responses
/** Content may be a plain string or a multimodal array — read either. */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === 'text' ? p.text : '')).filter(Boolean).join(' ');
  }
  return '';
}

// Helper for Mock responses
async function streamMockResponse(res, messages, model, thinkingLevel) {
  const lastMsg = messageText(messages[messages.length - 1]?.content) || 'Hello';
  const isReasoning = String(model || '').includes('reasoning') || thinkingLevel !== 'Auto';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // If reasoning model or thinking requested
  if (isReasoning) {
    sendEvent({ status: 'Thinking...' });
    await new Promise((r) => setTimeout(r, 600));
    sendEvent({ status: `Analyzing request (Reasoning effort: ${thinkingLevel})...` });
    await new Promise((r) => setTimeout(r, 500));
  } else {
    sendEvent({ status: 'Generating...' });
    await new Promise((r) => setTimeout(r, 250));
  }

  // Generate realistic response based on user message
  let answerParts = [];
  const lower = lastMsg.toLowerCase();


  if (lower.includes('code') || lower.includes('python') || lower.includes('function') || lower.includes('script')) {
    answerParts = [
      `Here is a clean and efficient solution for your request.\n\n`,
      `### Implementation\n\n`,
      `We can implement this using modern best practices:\n\n`,
      `\`\`\`python\n`,
      `import asyncio\n`,
      `from typing import List, Dict, Any\n\n`,
      `class TaskProcessor:\n`,
      `    """Processes tasks asynchronously with rate limiting."""\n`,
      `    def __init__(self, concurrency_limit: int = 5) -> None:\n`,
      `        self.semaphore = asyncio.Semaphore(concurrency_limit)\n\n`,
      `    async def process_item(self, item_id: str, data: Dict[str, Any]) -> Dict[str, Any]:\n`,
      `        async with self.semaphore:\n`,
      `            # Simulate processing work\n`,
      `            await asyncio.sleep(0.1)\n`,
      `            return {"id": item_id, "status": "completed", "result": len(data)}\n\n`,
      `async def main():\n`,
      `    processor = TaskProcessor(concurrency_limit=3)\n`,
      `    results = await processor.process_item("item-101", {"name": "sample"})\n`,
      `    print(f"Task result: {results}")\n\n`,
      `if __name__ == "__main__":\n`,
      `    asyncio.run(main())\n`,
      `\`\`\`\n\n`,
      `### Key Features\n\n`,
      `- **Thread-safe**: Utilizes \`asyncio.Semaphore\` to bound concurrent operations.\n`,
      `- **Type Annotations**: Clean types with \`typing.Dict\` and \`typing.Any\`.\n`,
      `- **Error Handling**: Drop-in expandable with standard try/except blocks.\n\n`,
      `You can test or customize this snippet as needed!`,
    ];
  } else if (lower.includes('table') || lower.includes('compare') || lower.includes('difference')) {
    answerParts = [
      `Here is a structured comparison:\n\n`,
      `| Feature | Model A | Model B | Notes |\n`,
      `| :--- | :--- | :--- | :--- |\n`,
      `| **Latency** | ~120 ms | ~450 ms | Fast streaming response |\n`,
      `| **Reasoning** | Standard | High-depth | Ideal for complex logic |\n`,
      `| **Context Window** | 128k tokens | 200k tokens | Ample memory for documents |\n`,
      `| **Code Quality** | Excellent | State-of-the-Art | Tested across benchmark suites |\n\n`,
      `Depending on your workload requirements, you can pick the model with the best balance of speed and depth.`,
    ];
  } else {
    answerParts = [
      `I have received your message:\n\n`,
      `> "${lastMsg}"\n\n`,
      `Here are the key points to consider:\n\n`,
      `1. **Clarity and Focus**: Keeping the interface flat, modern, and uncluttered helps users stay in the flow.\n`,
      `2. **Provider Flexibility**: You can seamlessly switch between OpenAI, Groq, Ollama, OpenRouter, or custom APIs at any time from the top selector.\n`,
      `3. **Thinking Controls**: Reasoning level (${thinkingLevel}) is automatically forwarded to supported models.\n\n`,
      `\`\`\`bash\n`,
      `# Test an API endpoint\n`,
      `curl -X POST http://localhost:3001/api/providers/test \\\n`,
      `  -H "Content-Type: application/json" \\\n`,
      `  -d '{"apiType": "mock"}'\n`,
      `\`\`\`\n\n`,
      `Let me know how else I can assist you!`,
    ];
  }

  // Stream chunk by chunk with natural cadence
  for (const part of answerParts) {
    const words = part.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? '' : ' ') + words[i];
      sendEvent({ content: chunk });
      await new Promise((r) => setTimeout(r, 22));
    }
  }

  sendEvent({ done: true });
  res.write('data: [DONE]\n\n');
  res.end();
}

// Chat Completion Stream
// Output cap for chat completions. Some providers count reasoning tokens
// against this budget, so a model that thinks a lot can be cut off mid-write
// long before it "runs out of answer". Overridable so a deployment whose
// provider allows more (or requires less) can tune it without editing code.
const CHAT_MAX_TOKENS =
  Number(process.env.DANAV_MAX_TOKENS) > 0 ? Number(process.env.DANAV_MAX_TOKENS) : 32768;

/**
 * The read-only web tools chat mode can call.
 *
 * These are the same three tools the search endpoint exposes; they are declared
 * here as OpenAI function schemas so the model can call them natively instead of
 * the client having to guess a query up front and run exactly one search.
 */
const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and get back a list of result titles, URLs and snippets. ' +
        'Use this for anything that needs current facts, news, prices, versions, ' +
        'schedules, or anything you are not certain about. You may call it more ' +
        'than once with different queries to cover different angles.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Keep it short and specific (2-8 keywords).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Read the full text of a specific web page. Use this after a web_search to ' +
        'open the most relevant result and get exact details (numbers, quotes, API ' +
        'signatures, version notes) that a snippet does not show.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute http(s) URL to read.' },
          query: {
            type: 'string',
            description:
              'Optional. A phrase to find inside the page; only the matching ' +
              'sentences are returned instead of the whole page.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description:
        'Search for images. Use this only when the user explicitly asks to see ' +
        'pictures, photos, logos or diagrams.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find images of.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'movie_search',
      description:
        'Search movies and TV shows from FlixRaid / TMDB database. Returns titles, posters, release years, and media IDs. ' +
        'ALWAYS use this tool whenever the user asks to search, find, recommend, or watch any movie or TV show. ' +
        'Present the movies so the user can see their posters and click to watch!',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The movie or TV show name to search for (e.g. "Batman", "Inception", "Spider-Man").',
          },
        },
        required: ['query'],
      },
    },
  },
];

/** How many tool rounds the model may run before it is made to answer. */
const MAX_TOOL_ROUNDS = Number(process.env.DANAV_MAX_TOOL_ROUNDS) > 0
  ? Number(process.env.DANAV_MAX_TOOL_ROUNDS)
  : 5;

/**
 * Appended to the conversation when tools are available.
 *
 * Two jobs: make the model actually reach for a search instead of guessing, and
 * make it STOP. Without the stopping rule a model can refine its queries
 * forever (Gemini does exactly that), so the loop never reaches an answer.
 */
const CHAT_TOOL_SYSTEM_PROMPT =
  'You have tools available: movie_search, web_search, fetch_url and image_search.\n' +
  '- Whenever the user asks for a movie, TV show, anime, or series to find, recommend, or watch, ALWAYS call movie_search with the title.\n' +
  '- When presenting movies or TV shows from movie_search, present the title, release year, TMDB rating/score, synopsis/overview, and poster (![title](poster_url)). The system will automatically render a complete, beautiful movie stat card with poster, rating, year, overview, and Watch Now button for the user!\n' +
  '- Use web_search whenever the answer depends on current or verifiable facts (news, prices, releases, documentation, people, statistics). Do not answer such questions from memory alone.\n' +
  '- Read a promising result with fetch_url when you need exact details.\n' +
  '- Do not repeat a search you have already run with the same query.\n' +
  '- Once you have enough information, STOP calling tools and write the final answer.\n' +
  '- If a tool fails, say so plainly rather than inventing the information.';

/**
 * Does this provider error mean "the prompt is too big"?
 *
 * The same detection the agent loop uses. A chat that has been running for hours
 * eventually exceeds the model's context window, and the provider answers 400
 * with a message about token limits — previously the turn just died there with
 * "Provider error (HTTP 400)".
 */
const isContextLimitError = (text) =>
  /(?:context.{0,40}(?:length|window|limit|exceed)|(?:maximum|max).{0,24}context|too many tokens|token limit|max(?:imum)?(?: number of)? tokens|tokens.{0,30}(?:maximum|max|limit)|exceeds? (?:the )?(?:token|input)|requested.{0,20}tokens|prompt.{0,24}(?:too (?:large|long)|exceed)|input.{0,24}too (?:large|long)|reduce (?:the )?(?:prompt|input|token))/i.test(
    String(text || '')
  );

/**
 * Drop the oldest exchanges, keeping whole user turns.
 *
 * Trimming must land on a user-message boundary: keeping an assistant tool-call
 * without the `tool` results that answer it (or a tool result without its call)
 * is rejected by every OpenAI-compatible provider as a malformed conversation.
 * System messages are always kept — that is where the tool instructions live.
 *
 * @returns {Array|null} the trimmed list, or null when there is nothing to drop
 */
/** How many user turns a message list holds. */
const countUserTurns = (messages) => (messages || []).filter((m) => m.role === 'user').length;

function trimOldestTurns(messages, keepTurns = 6) {
  if (!Array.isArray(messages)) return null;
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const userIndexes = rest.reduce((acc, m, i) => (m.role === 'user' ? [...acc, i] : acc), []);
  if (userIndexes.length <= keepTurns) return null;

  const start = userIndexes[userIndexes.length - keepTurns];
  if (start <= 0) return null;
  return [...system, ...rest.slice(start)];
}

app.post('/api/chat', async (req, res) => {
  const { provider: suppliedProvider, model: modelInput, messages, thinkingLevel, toolsEnabled } = req.body || {};
  const provider = providerWithStoredCredentials(suppliedProvider);

  if (!provider) {
    return res.status(400).json({ error: 'Provider configuration is missing' });
  }

  const refusal = metadataUrlRefusal(provider);
  if (refusal) {
    return res.status(400).json({ error: refusal });
  }

  const urlProblem = baseUrlProblem(provider.baseUrl);
  if (urlProblem) {
    return res.status(400).json({ error: urlProblem });
  }

  if (!modelInput) {
    return res.status(400).json({ error: 'Model selection is missing' });
  }

  /**
   * Everything below treats the model as a plain id string (`model.includes(...)`,
   * `model.toLowerCase()`). A caller that hands over the whole model object — or a number —
   * used to take the route down with "model.includes is not a function"; accept it instead.
   */
  const model =
    typeof modelInput === 'string'
      ? modelInput.trim()
      : String(modelInput?.id ?? modelInput?.name ?? '').trim();
  if (!model) {
    return res.status(400).json({ error: 'Model selection is missing (expected a model id).' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }
  // Every entry is about to be read as `m.role`, `m.content`. A null or a number
  // in the list used to take the whole route down with a TypeError.
  const malformedIndex = messages.findIndex(
    (m) => !m || typeof m !== 'object' || typeof m.role !== 'string' || !m.role
  );
  if (malformedIndex !== -1) {
    return res.status(400).json({
      error: `Message ${malformedIndex + 1} of ${messages.length} is not a valid chat message (expected an object with a role).`,
    });
  }

  // Handle Mock provider
  if (provider.apiType === 'mock') {
    return streamMockResponse(res, messages, model, thinkingLevel || 'Auto');
  }

  // Handle OpenAI-compatible / external providers
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!baseUrl) {
    return res.status(400).json({ error: 'Provider Base URL is required' });
  }

  const endpoint = `${baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream, application/json',
  };

  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey.trim()}`;
  }

  // Format messages
  const payloadMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // ---- Tool loop ----------------------------------------------------------
  //
  // `conversation` is the working message list for this turn. It starts as the
  // client's history and grows as the model researches: each round's assistant
  // tool calls and their results are appended, so the next round sees what has
  // already been learned.
  const useTools = Boolean(toolsEnabled);
  // Reassignable: an over-long history is trimmed and the request retried.
  let conversation = payloadMessages.slice();
  if (useTools) {
    conversation.unshift({ role: 'system', content: CHAT_TOOL_SYSTEM_PROMPT });
  }

  // Keep the request shape identical in chat and Agent mode. Gemini's Auto
  // effort leaves the model default alone while requesting thought summaries.
  const selectedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  const requestModel = modelForProvider(baseUrl, model);
  const configuredThinking = thinkingParams({ model: requestModel, baseUrl, level: selectedThinkingLevel });
  const hasThinkingConfig = Object.keys(configuredThinking).length > 0;

  const buildRequestBody = (withTools, withThinking) => {
    const body = {
      model: requestModel,
      messages: conversation,
      stream: true,
      max_tokens: CHAT_MAX_TOKENS,
    };
    if (withTools) {
      body.tools = CHAT_TOOLS;
      body.tool_choice = 'auto';
    }
    if (withThinking) Object.assign(body, configuredThinking);
    return body;
  };

  const writeEvent = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    const callProvider = (withTools, withThinking, messageList) => {
      const body = buildRequestBody(withTools, withThinking);
      if (messageList) body.messages = messageList;
      return fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    };

    /**
     * Stream one upstream round to completion.
     *
     * Returns the round's visible text plus every tool call it asked for. Tool
     * calls are collected from the deltas — NOT from `finish_reason`, because
     * Gemini reports `stop` while still emitting them, which would silently
     * drop the call and end the turn with an empty answer.
     */
    const streamOneRound = async (upstream, separateFromPrevious) => {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // One splitter per round: it carries the fence/thought state that keeps
      // literal "<thought>" text from flipping the channel mid-stream.
      const splitDelta = createStreamSplitter();
      let text = '';
      const toolAcc = new Map();
      // Each research round narrates itself ("Let me check the changelog…").
      // Without a break the rounds run together into one unreadable sentence,
      // so a new round opens with a blank line before its first words.
      let pendingSeparator = Boolean(separateFromPrevious);

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return;
        if (trimmed === 'data: [DONE]') return;
        if (!trimmed.startsWith('data: ')) return;

        let parsed;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          return; // partial chunk
        }

        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason) writeEvent({ finishReason });

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) return;

        const isGoogleThought = delta.extra_content?.google?.thought === true;
        const reasoningField =
          delta.reasoning_content || delta.reasoning || delta.thought || delta.thinking;

        if (reasoningField) {
          writeEvent({ thinking: reasoningField });
        }

        if (isGoogleThought) {
          const thoughtText = (delta.content || '').replace(/<\/?thought>/gi, '');
          if (thoughtText) writeEvent({ thinking: thoughtText });
        } else if (delta.content) {
          for (const event of splitDelta(delta.content)) {
            if (event.content) {
              if (pendingSeparator) {
                pendingSeparator = false;
                text += '\n\n';
                writeEvent({ content: '\n\n' });
              }
              text += event.content;
            }
            writeEvent(event);
          }
        }

        for (const call of delta.tool_calls || []) {
          const idx = call.index ?? 0;
          if (!toolAcc.has(idx)) {
            toolAcc.set(idx, { id: '', name: '', args: '', extra_content: null });
          }
          const slot = toolAcc.get(idx);
          if (call.id) slot.id = call.id;
          // Gemini hands back a thought_signature that MUST be echoed verbatim
          // on the assistant message when the tool result is returned —
          // without it the next request is rejected with HTTP 400.
          if (call.extra_content) slot.extra_content = call.extra_content;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.args += call.function.arguments;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
      }
      for (const event of splitDelta.flush()) {
        if (event.content) text += event.content;
        writeEvent(event);
      }

      return { text, toolCalls: [...toolAcc.values()] };
    };

    /**
     * Run one model-requested tool call, emitting the lifecycle the UI renders
     * (running -> done) and returning the plain text the model reads next round.
     *
     * A failure is reported as text too: the model needs to see that a search
     * came back empty so it can rephrase, rather than the turn dying.
     */
    const runToolCall = async (call, alreadyRan) => {
      let args = {};
      try {
        args = call.args ? JSON.parse(call.args) : {};
      } catch {
        args = {};
      }

      const name = call.name || 'web_search';
      const id = call.id || `call_${Math.random().toString(36).slice(2, 10)}`;

      // Arguments arrive as a JSON string; if the model mangled it we can still
      // salvage the query/url rather than failing the whole call.
      if (typeof args.query !== 'string' && typeof args.url !== 'string') {
        const salvage = /"?(?:query|url|q)"?\s*[:=]\s*"([^"]+)"/i.exec(call.args || '');
        if (salvage) args = { ...args, query: salvage[1], url: salvage[1] };
      }

      const key = `${name}:${JSON.stringify(args)}`;
      if (alreadyRan.has(key)) {
        const reuse = {
          id,
          name,
          status: 'done',
          ok: true,
          skipped: true,
          summary: 'Already searched — reusing the earlier results',
        };
        writeEvent({ tool: reuse });
        return {
          event: reuse,
          text:
            'You already ran this exact call earlier in this turn; its results are ' +
            'in the conversation above. Do not repeat it — either use a different ' +
            'query or write the final answer now.',
        };
      }
      alreadyRan.add(key);

      const label =
        name === 'fetch_url'
          ? args.url || '(missing url)'
          : args.query || '(missing query)';

      writeEvent({ tool: { id, name, status: 'running', query: label } });

      const result = await runSearchTool(name, args);

      const ok = Boolean(result && result.success);
      const detail = String(result?.output || result?.error || '').trim();

      if (name === 'image_search') {
        writeEvent({
          tool: {
            id,
            name,
            status: 'done',
            ok,
            query: label,
            summary: ok ? `${(result.images || []).length} images` : 'No images found',
            images: (result.images || []).slice(0, 8),
          },
        });
      } else if (name === 'movie_search') {
        const count = (result?.results || []).length;
        writeEvent({
          tool: {
            id,
            name,
            status: 'done',
            ok,
            query: label,
            summary: ok ? `${count} title${count === 1 ? '' : 's'}` : 'No movies found',
            detail: detail.slice(0, 1500),
            movies: (result?.results || []).slice(0, 8),
          },
        });
      } else {
        const count = name === 'web_search' ? (result?.results || []).length : undefined;
        writeEvent({
          tool: {
            id,
            name,
            status: 'done',
            ok,
            query: label,
            summary: ok
              ? name === 'web_search'
                ? `${count} result${count === 1 ? '' : 's'}`
                : undefined
              : 'Failed',
            detail: detail.slice(0, 1200),
          },
        });
      }

      const text = ok
        ? detail
        : `${name} failed: ${result?.error || 'unknown error'}. Do not invent the ` +
          `information — try a different query or source, or tell the user it could not be fetched.`;

      return { event: null, text: text || '(no content)' };
    };

    // The first round is fetched BEFORE any headers are written, so a hard
    // provider failure can still be reported as a real HTTP status the client
    // understands. Later rounds can only report through the SSE stream.
    //
    // Each rung drops one feature: some providers reject the thinking config,
    // and a few proxies reject `tools` outright. Losing a feature beats losing
    // the whole turn.
    // Preserve an explicitly selected effort before sacrificing optional tools.
    // Auto may fall back from the optional thought-summary flag, but a chosen
    // Low/Medium/High level is never silently dropped.
    const ladder = [{ tools: useTools, thinking: hasThinkingConfig }];
    if (useTools) ladder.push({ tools: false, thinking: hasThinkingConfig });
    if (selectedThinkingLevel === 'Auto' && hasThinkingConfig) {
      ladder.push({ tools: useTools, thinking: false });
      if (useTools) ladder.push({ tools: false, thinking: false });
    }

    let upstreamResponse = null;
    let toolsActive = false;
    let thinkingActive = false;
    let failedStep = ladder[0];
    let lastErrorBody = '';
    let contextTrimmed = false;

    const attemptUpstream = async () => {
      for (let i = 0; i < ladder.length; i++) {
        const step = ladder[i];
        failedStep = step;
        upstreamResponse = await callProvider(step.tools, step.thinking);
        if (upstreamResponse.ok) {
          toolsActive = step.tools;
          thinkingActive = step.thinking;
          return;
        }
        // 401 / 404 / 429 are real errors — no point retrying a different shape.
        if (upstreamResponse.status !== 400) return;
        lastErrorBody = await upstreamResponse.text().catch(() => '');
        if (i < ladder.length - 1) {
          console.log(
            `Provider rejected request (HTTP 400) on ${model}; retrying while preserving selected reasoning effort`
          );
        }
      }
    };

    await attemptUpstream();

    // A conversation that outgrew the model's context window is recoverable: drop
    // the oldest exchanges (on a user-turn boundary) and try again. Without this
    // the only answer was "Provider error (HTTP 400)" with no way forward except
    // deleting messages by hand, which is not something a user can be asked to do.
    //
    // Each retry keeps half of what the last one had, so a history that is far too
    // long (or a model with a small window) converges instead of failing on a
    // second 400. Three retries is enough to take any history down to two turns.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stillTooLong =
        !upstreamResponse.ok && upstreamResponse.status === 400 && isContextLimitError(lastErrorBody);
      if (!stillTooLong) break;

      const keepTurns = Math.max(2, Math.ceil(countUserTurns(conversation) / 2));
      const trimmed = trimOldestTurns(conversation, keepTurns);
      if (!trimmed) break;

      conversation = trimmed;
      contextTrimmed = true;
      console.log(
        `Chat history exceeded the model context on ${model}; retrying with the last ${keepTurns} turns.`
      );
      await attemptUpstream();
    }

    if (!upstreamResponse.ok) {
      const errText = lastErrorBody || await upstreamResponse.text().catch(() => '');
      let errorMsg = `Provider error (HTTP ${upstreamResponse.status})`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          errorMsg = parsed.error.message;
        } else if (parsed.message) {
          errorMsg = parsed.message;
        }
      } catch {
        if (errText && errText.length < 200) errorMsg = errText;
      }

      if (upstreamResponse.status === 401) {
        errorMsg = 'Invalid API Key. Please verify the key in Settings.';
      } else if (upstreamResponse.status === 404) {
        errorMsg = `Model "${model}" or endpoint not found on provider. Check provider settings.`;
      } else if (upstreamResponse.status === 429) {
        errorMsg = 'Rate limit reached or quota exceeded on provider.';
      }

      const code = upstreamResponse.status === 400 && selectedThinkingLevel !== 'Auto' && failedStep.thinking
        ? 'thinking_unsupported'
        : undefined;
      if (code) {
        errorMsg = `The provider rejected the selected ${selectedThinkingLevel} thinking effort. Danav did not lower or remove it; check that this model and endpoint support that level. (${errorMsg})`;
      }

      return res.status(upstreamResponse.status).json({ error: errorMsg.slice(0, 1000), ...(code ? { code } : {}) });
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const startupNotices = [];
    if (contextTrimmed) {
      startupNotices.push(
        "This conversation is longer than the model's context window, so the oldest messages were left out of this request — they are still in the chat."
      );
    }
    if (useTools && !toolsActive) startupNotices.push('Provider rejected web tools; continuing without web search.');
    if (hasThinkingConfig && !thinkingActive) startupNotices.push('Provider rejected Gemini thought summaries; using its default effort without a thought box.');
    writeEvent({ status: startupNotices.length ? startupNotices.join(' ') : toolsActive ? 'Researching...' : 'Generating...' });

    // ---- Rounds -------------------------------------------------------------
    // Rounds 0..MAX_TOOL_ROUNDS-1 may call tools. If the model is still asking
    // for tools when the budget runs out, one final round is run with the tools
    // withdrawn and the research flattened into plain text — that guarantees a
    // written answer instead of an endless search loop.
    const alreadyRan = new Set();
    let answered = false;
    let upstream = upstreamResponse;
    // Tracks whether anything visible has been written yet, so a separator is
    // only inserted BETWEEN rounds and never as a leading blank line.
    let streamedContent = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (round > 0) {
        upstream = await callProvider(toolsActive, thinkingActive);
        if (!upstream.ok) {
          const body = await upstream.text().catch(() => '');
          writeEvent({
            error: `Provider stopped responding during research (HTTP ${upstream.status})${body ? `: ${body.slice(0, 150)}` : ''}`,
          });
          break;
        }
      }

      const { text, toolCalls } = await streamOneRound(upstream, streamedContent);
      if (text) streamedContent = true;

      if (toolCalls.length === 0) {
        answered = true;
        break;
      }

      // Echo the assistant turn (text + calls) so the model sees its own request,
      // then append each result as a `tool` message.
      conversation.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((c, i) => ({
          id: c.id || `call_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
          ...(c.extra_content ? { extra_content: c.extra_content } : {}),
        })),
      });

      for (const call of toolCalls) {
        const { text: resultText } = await runToolCall(call, alreadyRan);
        conversation.push({
          role: 'tool',
          tool_call_id: call.id || 'call_0',
          content: resultText,
        });
      }
    }

    if (!answered) {
      // Forced final round. `tool_choice: 'none'` is not enough — Gemini
      // ignores it and keeps calling tools. Withdrawing the tools AND flattening
      // the history to plain text leaves the model nothing to call, so it has to
      // answer. (Verified against Gemini 3.5 Flash and DeepSeek v4.1.)
      writeEvent({ status: 'Writing answer...' });

      const flat = [];
      const research = [];
      for (const m of conversation) {
        if (m.role === 'system') {
          flat.push(m);
        } else if (m.role === 'tool') {
          research.push(m.content);
        } else if (m.role === 'assistant') {
          if (m.content) flat.push({ role: 'assistant', content: m.content });
        } else {
          flat.push({ role: m.role, content: m.content });
        }
      }
      if (research.length > 0) {
        flat.push({
          role: 'user',
          content:
            'Here is the information gathered from the web tools:\n\n' +
            research.join('\n\n---\n\n') +
            '\n\nUsing the information above, write the final answer now. ' +
            'Do not request any more searches.',
        });
      }

      const finalRes = await callProvider(false, thinkingActive, flat);
      if (!finalRes.ok) {
        const body = await finalRes.text().catch(() => '');
        writeEvent({
          error: `Could not finish the answer (HTTP ${finalRes.status})${body ? `: ${body.slice(0, 150)}` : ''}`,
        });
      } else {
        await streamOneRound(finalRes, streamedContent);
      }
    }

    writeEvent({ status: '' });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      res.end();
      return;
    }
    console.error('Chat error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: `Connection error: ${err.message || 'Network failure'}` });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Stream error' })}\n\n`);
      res.end();
    }
  }
});

// ==========================================
// Web tools (chat mode)
// ==========================================
/**
 * The only tools this app still exposes: search the web, search images, read a
 * page. They used to live inside the agent's /api/agent/execute-tool endpoint,
 * beside write_file / edit_file / read_command / list_dir. Agent mode is gone,
 * and with it every tool that could reach the filesystem or spawn a shell, so
 * the browser can no longer do either through this server. What is left is the
 * read-only part the chat's Search toggle actually uses.
 */
async function handleSearchTool(req, res) {
  const { tool } = req.body || {};
  // `args = {}` only covers `undefined`: an explicit `"args": null` used to reach
  // the handlers and be read as `args.query`, taking the route down.
  const args = req.body?.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args)
    ? req.body.args
    : {};

  try {
    if (tool === 'web_search') {
      const rawQuery = args.query || args.q;
      if (!rawQuery || typeof rawQuery !== 'string') {
        return res.status(400).json({ error: 'Search query is required' });
      }
      // Normalise: collapse whitespace and cap length so a runaway query cannot
      // break the search URLs or return junk.
      const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      try {
        const results = [];
        const MAX_RESULTS = 8;
        const domainCounts = new Map();
        let enginesBlocked = 0;

        /** Accept a result only if it is a real, distinct, useful page. */
        const addResult = (title, url, snippet) => {
          if (!title || !url || results.length >= MAX_RESULTS) return;
          if (!/^https?:\/\//i.test(url)) return;
          if (/duckduckgo\.com|bing\.com|google\.com\/search|w3\.org/i.test(url)) return;

          let host = '';
          try {
            host = new URL(url).hostname.replace(/^www\./, '');
          } catch {
            return;
          }

          // Cap 2 results per domain so one site cannot dominate the list.
          const count = domainCounts.get(host) || 0;
          if (count >= 2) return;
          if (results.some((r) => r.url === url)) return;

          domainCounts.set(host, count + 1);
          results.push({
            title: textFromHtml(title).slice(0, 200),
            url,
            snippet: textFromHtml(snippet).slice(0, 500),
            source: host,
          });
        };

        /** Pull (url, title) pairs out of an HTML search page by CSS class. */
        const extractLinksByClass = (html, classNeedle) => {
          const out = [];
          const patterns = [
            new RegExp(
              `<a[^>]+class=["'][^"']*${classNeedle}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>`,
              'gi'
            ),
            new RegExp(
              `<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*${classNeedle}[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`,
              'gi'
            ),
          ];
          for (const re of patterns) {
            let m;
            while ((m = re.exec(html)) !== null) out.push({ url: m[1], title: m[2] });
          }
          return out;
        };

        // Tier 1: DuckDuckGo HTML endpoint (best snippet quality)
        try {
          const ddgHtmlRes = await fetchWithTimeout(
            'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
            {
              headers: {
                'User-Agent': BROWSER_UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
              },
            },
            9000
          );

          if (ddgHtmlRes.ok) {
            const html = await ddgHtmlRes.text();

            if (looksLikeBotWall(ddgHtmlRes.status, html, ddgHtmlRes.headers)) {
              enginesBlocked++;
            } else {
              // Preferred markup: class-tagged title/snippet anchors, paired by order.
              const titleMatches = [
                ...html.matchAll(
                  /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
                ),
              ];
              const snippetMatches = [
                ...html.matchAll(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi),
              ];

              for (let i = 0; i < titleMatches.length; i++) {
                let url = titleMatches[i][1];
                const uddg = url.match(/uddg=([^&]+)/);
                if (uddg) url = decodeURIComponent(uddg[1]);
                const snippet = snippetMatches[i] ? snippetMatches[i][1] : '';
                addResult(titleMatches[i][2], url, snippet);
              }

              // Fallback markup: any outbound link carrying a uddg redirect.
              if (results.length === 0) {
                const genericRegex =
                  /<a[^>]+href=["'](?:\/\/duckduckgo\.com\/l\/\?uddg=|[^"']*uddg=)([^"&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
                let m;
                while ((m = genericRegex.exec(html)) !== null) {
                  const snippetSub = html.slice(m.index, m.index + 900);
                  const snipMatch = /class=["']result__snippet["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(snippetSub);
                  addResult(m[2], decodeURIComponent(m[1]), snipMatch ? snipMatch[1] : '');
                }
              }
            }
          } else if (ddgHtmlRes.status === 403 || ddgHtmlRes.status === 429 || ddgHtmlRes.status === 503) {
            enginesBlocked++;
          }
        } catch (e) {}

        // Tier 2: DuckDuckGo Lite
        if (results.length === 0) {
          try {
            const ddgRes = await fetchWithTimeout(
              'https://lite.duckduckgo.com/lite/',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': BROWSER_UA,
                },
                body: 'q=' + encodeURIComponent(query),
              },
              9000
            );

            if (ddgRes.ok) {
              const html = await ddgRes.text();
              if (looksLikeBotWall(ddgRes.status, html, ddgRes.headers)) {
                enginesBlocked++;
              } else {
                const linkMatches = extractLinksByClass(html, 'result-link');
                const snippetMatches = [
                  ...html.matchAll(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi),
                ];

                for (let i = 0; i < linkMatches.length; i++) {
                  let url = linkMatches[i].url;
                  const udMatch = url.match(/uddg=([^&]+)/);
                  if (udMatch) url = decodeURIComponent(udMatch[1]);
                  addResult(linkMatches[i].title, url, snippetMatches[i] ? snippetMatches[i][1] : '');
                }
              }
            } else if (ddgRes.status === 403 || ddgRes.status === 429 || ddgRes.status === 503) {
              enginesBlocked++;
            }
          } catch (e) {}
        }

        // Tier 3: Bing HTML — a completely independent index, so a DuckDuckGo
        // block/rate-limit no longer leaves the search with nothing.
        if (results.length === 0) {
          try {
            const bingRes = await fetchWithTimeout(
              'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=en&count=20',
              {
                headers: {
                  'User-Agent': BROWSER_UA,
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
              },
              9000
            );
            if (bingRes.ok) {
              const html = await bingRes.text();
              if (looksLikeBotWall(bingRes.status, html, bingRes.headers)) {
                enginesBlocked++;
              } else {
                // Bing wraps each organic result in <li class="b_algo">.
                const blocks = html.split(/<li class="b_algo"/i).slice(1);
                for (const chunk of blocks) {
                  const link = /<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
                  if (!link) continue;
                  const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
                  addResult(link[2], decodeBingUrl(link[1]), snip ? snip[1] : '');
                  if (results.length >= MAX_RESULTS) break;
                }
              }
            } else if (bingRes.status === 403 || bingRes.status === 429 || bingRes.status === 503) {
              enginesBlocked++;
            }
          } catch (e) {}
        }

        // Tier 4: Mojeek — small independent crawler, very scrape-friendly and
        // it does not serve JS challenges for plain fetches.
        if (results.length === 0) {
          try {
            const mjRes = await fetchWithTimeout(
              'https://www.mojeek.com/search?q=' + encodeURIComponent(query),
              {
                headers: {
                  'User-Agent': BROWSER_UA,
                  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
              },
              9000
            );
            if (mjRes.ok) {
              const html = await mjRes.text();
              if (looksLikeBotWall(mjRes.status, html, mjRes.headers)) {
                enginesBlocked++;
              } else {
                let links = extractLinksByClass(html, 'ob');
                if (links.length === 0) {
                  // Mojeek markup shifts occasionally — fall back to the h2 anchor.
                  links = [...html.matchAll(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(
                    (m) => ({ url: m[1], title: m[2] })
                  );
                }
                const snips = [...html.matchAll(/<p class=["']s["'][^>]*>([\s\S]*?)<\/p>/gi)];
                for (let i = 0; i < links.length; i++) {
                  addResult(links[i].title, links[i].url, snips[i] ? snips[i][1] : '');
                  if (results.length >= MAX_RESULTS) break;
                }
              }
            } else if (mjRes.status === 403 || mjRes.status === 429 || mjRes.status === 503) {
              enginesBlocked++;
            }
          } catch (e) {}
        }

        // Tier 5: DuckDuckGo Instant Answer API (direct abstract when available)
        if (results.length === 0) {
          try {
            const apiRes = await fetchWithTimeout(
              `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
              { headers: { 'User-Agent': BROWSER_UA } },
              7000
            );
            if (apiRes.ok) {
              const data = await apiRes.json();
              if (data.AbstractText && data.AbstractURL) {
                addResult(data.Heading || query, data.AbstractURL, data.AbstractText);
              }
              for (const topic of (data.RelatedTopics || []).slice(0, 4)) {
                if (topic.FirstURL && topic.Text) {
                  addResult(topic.Text.split(' - ')[0], topic.FirstURL, topic.Text);
                }
              }
            }
          } catch (e) {}
        }

        // Tier 6: Wikipedia OpenSearch — a genuine last resort only.
        // This used to run whenever fewer than 3 hits were found, which injected
        // unrelated encyclopaedia links into technical searches and made the
        // agent cite the wrong sources.
        if (results.length === 0) {
          try {
            const wikiRes = await fetchWithTimeout(
              'https://en.wikipedia.org/w/api.php?action=opensearch&search=' +
                encodeURIComponent(query) +
                '&limit=5&namespace=0&format=json',
              { headers: { 'User-Agent': BROWSER_UA } },
              7000
            );
            if (wikiRes.ok) {
              const data = await wikiRes.json();
              const titles = data[1] || [];
              const snippets = data[2] || [];
              const urls = data[3] || [];
              for (let i = 0; i < titles.length; i++) {
                if (urls[i]) {
                  addResult(titles[i], urls[i], snippets[i] || `Wikipedia entry on ${titles[i]}`);
                }
              }
            }
          } catch (e) {}
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.title}](${r.url})\n   Source: ${r.source}\n   ${r.snippet || 'No description available.'}`
          )
          .join('\n\n');

        const guidance =
          results.length === 0
            ? enginesBlocked > 0
              ? `No results for "${query}". ${enginesBlocked} search engine(s) blocked the request (rate-limit / bot protection). Do NOT invent an answer — wait a moment and try again, or rephrase with 2-5 keywords.`
              : `No results found for "${query}". Do NOT invent an answer. Try again with a shorter, more specific query (2-5 keywords), or use a different tool.`
            : results.length < 3
            ? `Only ${results.length} result(s). If this is not enough, refine the query and search again, or fetch one of these pages with <fetch_url> for full details.`
            : 'If you need exact API details, code samples or version numbers, open the most relevant link with <fetch_url>. Always cite the sources you actually used as markdown links.';

        return res.json({
          success: results.length > 0,
          tool: 'web_search',
          query,
          results,
          enginesBlocked,
          output: results.length > 0 ? `${formatted}\n\n${guidance}` : guidance,
        });
      } catch (err) {
        // success:false so the caller knows the search failed rather than
        // treating an empty list as "the web has no answer".
        return res.json({
          success: false,
          tool: 'web_search',
          query,
          results: [],
          error: `Web search failed: ${err.message}`,
          output: `Web search for "${query}" failed (${err.message}). Do not guess — try a different query, or answer from what you already know and say so.`,
        });
      }
    }

    if (tool === 'image_search') {
      const rawQuery = args.query || args.q;
      if (!rawQuery || typeof rawQuery !== 'string') {
        return res.status(400).json({ error: 'Image search query is required' });
      }
      const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!query) {
        return res.status(400).json({ error: 'Image search query is required' });
      }

      try {
        const images = [];
        const MAX_IMAGES = 8;

        const addImage = (title, url, thumbnail, source) => {
          if (!url || images.length >= MAX_IMAGES) return;
          if (!/^https?:\/\//i.test(url)) return;
          if (images.some((img) => img.url === url)) return;
          images.push({
            title: textFromHtml(title || query).slice(0, 200),
            url,
            thumbnail: thumbnail || url,
            source: source || 'Web',
          });
        };

        // Tier 1: DuckDuckGo image API via the page token
        try {
          const tokenRes = await fetchWithTimeout(
            'https://duckduckgo.com/?q=' + encodeURIComponent(query),
            { headers: { 'User-Agent': BROWSER_UA } },
            8000
          );
          const tokenHtml = await tokenRes.text();

          // The token is embedded in a script blob. Prefer the JSON-ish form
          // (vqd="4-123…") and fall back to the query-string form (vqd=4-123…).
          const vqdMatch =
            tokenHtml.match(/vqd=["']([^"']{8,})["']/i) ||
            tokenHtml.match(/vqd=([0-9]+-[0-9]+(?:-[0-9]+)?)/i);
          const vqd = vqdMatch ? vqdMatch[1] : '';

          if (vqd) {
            const imgRes = await fetchWithTimeout(
              `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,`,
              {
                headers: {
                  'User-Agent': BROWSER_UA,
                  Referer: 'https://duckduckgo.com/',
                  Accept: 'application/json, text/javascript, */*; q=0.01',
                  'X-Requested-With': 'XMLHttpRequest',
                },
              },
              8000
            );
            if (imgRes.ok) {
              const imgData = await imgRes.json();
              if (Array.isArray(imgData.results)) {
                for (const r of imgData.results) {
                  if (r.image) addImage(r.title, r.image, r.thumbnail, r.source);
                }
              }
            }
          }
        } catch (e) {}

        // Tier 2: Openverse (CC-licensed real image search, no key required)
        if (images.length === 0) {
          try {
            const openRes = await fetchWithTimeout(
              `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=8&license_type=all`,
              { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } },
              9000
            );
            if (openRes.ok) {
              const data = await openRes.json();
              for (const r of data.results || []) {
                addImage(r.title, r.url, r.thumbnail, r.source || r.provider || 'Openverse');
              }
            }
          } catch (e) {}
        }

        // Tier 3: Wikimedia Commons (always available, encyclopaedic imagery)
        if (images.length === 0) {
          try {
            const res = await fetchWithTimeout(
              'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=' +
                encodeURIComponent(query) +
                '&gsrlimit=8&prop=imageinfo&iiprop=url|size&format=json',
              { headers: { 'User-Agent': BROWSER_UA } },
              9000
            );
            if (res.ok) {
              const data = await res.json();
              const pages = Object.values(data.query?.pages || {});
              for (const p of pages) {
                const info = p.imageinfo?.[0];
                if (info?.url && /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(info.url)) {
                  addImage(
                    (p.title || query).replace(/^File:/, '').replace(/\.[^.]+$/, ''),
                    info.url,
                    info.url,
                    'Wikimedia Commons'
                  );
                }
              }
            }
          } catch (e) {}
        }

        // Present images as markdown so they render inline in the chat.
        const formatted =
          images.length > 0
            ? images
                .map(
                  (img, i) =>
                    `${i + 1}. ![${img.title}](${img.url})\n   Title: ${img.title}\n   Source: ${img.source}`
                )
                .join('\n\n') +
              `\n\nEmbed the images you actually used in your reply as markdown: ![title](url). Always credit the source.`
            : `No images found for "${query}". Try a simpler, more visual query (e.g. "red sports car") or tell the user no images were found.`;

        return res.json({
          success: images.length > 0,
          tool: 'image_search',
          query,
          images,
          output: formatted,
        });
      } catch (err) {
        return res.json({
          success: false,
          tool: 'image_search',
          query,
          images: [],
          error: err.message,
          output:
            `Image search failed for "${query}": ${err.message}. ` +
            `Do not invent image URLs. Either retry once with a simpler query, or tell the user images could not be loaded.`,
        });
      }
    }

    if (tool === 'movie_search') {
      const rawQuery = args.query || args.q || args.name || args.title;
      if (!rawQuery || typeof rawQuery !== 'string') {
        return res.status(400).json({ error: 'Movie search query is required' });
      }
      const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 200);

      // Configurable so a deployment can use its own key (higher limits, no shared
      // quota). The default is TMDB's long-published public sample key.
      const TMDB_API_KEY = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';

      try {
        let results = [];

        // 1. Try our direct high-speed TMDB multi-search engine first
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&api_key=${TMDB_API_KEY}&include_adult=false&language=en-US&page=1`;
          const tmdbRes = await fetchWithTimeout(tmdbUrl, {
            headers: {
              'User-Agent': BROWSER_UA,
              Accept: 'application/json',
            },
          }, 6000);

          if (tmdbRes.ok) {
            const data = await tmdbRes.json();
            if (Array.isArray(data?.results) && data.results.length > 0) {
              results = data.results
                .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
                .map((item) => {
                  const type = item.media_type;
                  const title = item.title || item.name || item.original_title || 'Untitled';
                  const date = item.release_date || item.first_air_date || '';
                  const year = date ? date.slice(0, 4) : '';
                  const poster = item.poster_path
                    ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                    : '';
                  // TMDB's vote_average is already a 0–10 score; keep it that way
                  // so the chat, the markdown and the movie card all agree.
                  const score = item.vote_average ? item.vote_average.toFixed(1) : '';
                  const overview = (item.overview || '').slice(0, 160);
                  return {
                    id: String(item.id),
                    title,
                    media_type: type,
                    year,
                    poster,
                    overview,
                    score,
                  };
                });
            }
          }
        } catch (e) {
          // Fallback to local flixraid or themoviedb.org web scraper if direct API is blocked
        }

        // 2. Optional fallback: a self-hosted catalogue API. Off unless configured
        //    (it used to point at http://localhost/flixraid/... — a path that only
        //    existed on the author's machine and just cost a 3s timeout here).
        const catalogueBase = (process.env.FLIXRAID_API_URL || '').replace(/\/+$/, '');
        if (results.length === 0 && catalogueBase) {
          try {
            const localApiUrl = `${catalogueBase}/api/search.php?q=${encodeURIComponent(query)}`;
            const localRes = await fetchWithTimeout(localApiUrl, {
              headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            }, 3000);
            if (localRes.ok) {
              const localData = await localRes.json();
              if (Array.isArray(localData?.results)) {
                results = localData.results.map((item) => ({
                  id: String(item.id),
                  title: item.title,
                  media_type: (item.media_type || 'movie').toLowerCase(),
                  year: item.year || '',
                  poster: item.poster || '',
                  overview: item.overview || '',
                  score: item.score || '',
                }));
              }
            }
          } catch (e) {}
        }

        // Filter and format the top results (up to 8)
        const formattedResults = results.slice(0, 8).map((item) => {
          const type = (item.media_type || 'movie').toLowerCase();
          const watchLink = `watch://${type}/${item.id}`;
          return {
            id: String(item.id),
            title: item.title,
            media_type: type,
            year: item.year || '',
            poster: item.poster,
            overview: item.overview || '',
            score: item.score || '',
            watchLink,
          };
        });

        const outputMarkdown = formattedResults.length > 0
          ? formattedResults
              .map(
                (m, i) =>
                  `### ${i + 1}. ${m.title} ${m.year ? `(${m.year})` : ''} [${m.media_type.toUpperCase()}]\n` +
                  (m.score ? `★ TMDB Rating: ${m.score}/10  \n` : '') +
                  (m.overview ? `*${m.overview}...*  \n` : '') +
                  (m.poster ? `![${m.title}](${m.poster})\n` : '') +
                  `[Watch Now](${m.watchLink})`
              )
              .join('\n\n')
          : `No movies or TV shows found matching "${query}" on TMDB / IMDb database.`;

        return res.json({
          success: formattedResults.length > 0,
          tool: 'movie_search',
          query,
          results: formattedResults,
          output: outputMarkdown,
        });
      } catch (err) {
        return res.json({
          success: false,
          tool: 'movie_search',
          query,
          results: [],
          error: err.message,
          output: `Movie search failed for "${query}": ${err.message}. Please verify the query and try again.`,
        });
      }
    }

    if (tool === 'fetch_url' || tool === 'read_url') {
      const targetUrl = args.url || args.link;
      const searchQuery = args.query || args.search_query || args.q;
      if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).json({ error: 'Target URL is required' });
      }

      let bodyText = '';
      let pageTitle = '';
      let blocked = false;
      let statusCode = 0;
      let fetchNote = '';
      // The address actually read: after a redirect chain it may differ from the
      // one asked for, and that is the URL the model is told about.
      let finalUrl = targetUrl;

      // Some sites 403 the first hit and serve the retry (rate-limit / bot
      // heuristics). One retry with a different UA turns a flaky 403 into a
      // successful read far more often than it costs.
      const USER_AGENTS = [
        BROWSER_UA,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      ];

      for (let attempt = 0; attempt < USER_AGENTS.length && !bodyText; attempt++) {
        try {
          // Every hop is checked before the request leaves this machine: a
          // public page may answer `302 → http://localhost:3001/api/settings`,
          // and the model must never be able to read a local service. See
          // server/publicFetch.js.
          const { response: pageRes, url: resolvedUrl } = await fetchPublicUrl(targetUrl, {
            timeoutMs: 12000,
            headers: {
              'User-Agent': USER_AGENTS[attempt],
              'Cache-Control': 'no-cache',
              // Browser-ish client hints: some bot walls check for these.
              'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Upgrade-Insecure-Requests': '1',
            },
          });
          finalUrl = resolvedUrl;
          statusCode = pageRes.status;
          const contentType = pageRes.headers.get('content-type') || '';
          const raw = await pageRes.text();

          if (!pageRes.ok || looksLikeBotWall(pageRes.status, raw, pageRes.headers)) {
            blocked = true;
            // A 5xx / 403 on the first try is often transient — retry once.
            if (attempt < USER_AGENTS.length - 1) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
          } else if (contentType.includes('html') || raw.includes('<html')) {
            const parsed = htmlToReadableText(raw);
            pageTitle = parsed.title;
            bodyText = parsed.text;
            blocked = false;
          } else {
            bodyText = raw.trim();
            blocked = false;
          }
        } catch (err) {
          // A refusal is final: retrying, curling or proxying it would be the
          // bypass this guard exists to prevent. Report it in its own words.
          if (err instanceof UrlRefusedError) {
            return res.json({
              success: false,
              tool: 'fetch_url',
              url: finalUrl,
              refused: true,
              error: err.message,
              output:
                `Refused to fetch ${finalUrl}: ${err.message}\n` +
                'Only public web pages can be read — local, private and cloud-metadata addresses are off limits. ' +
                'Use a link from a web search instead, or answer from the search snippets.',
            });
          }
          blocked = true;
          statusCode = 0;
          if (attempt < USER_AGENTS.length - 1) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
        }
      }

      // Direct fetch failed or hit a security wall.
      //
      // Order matters: curl first (fast, and its TLS stack is not fingerprinted
      // by Cloudflare the way Node's is), then the reader proxies (slower, but
      // they render JavaScript-only pages).
      if (blocked || bodyText.length < 120) {
        const viaCurl = await fetchViaCurl(targetUrl, { userAgent: BROWSER_UA });
        // curl follows redirects with -L and cannot be watched hop by hop, so the
        // address it reports landing on is checked before its body is used: a
        // public URL must not be a way to read a private one.
        const curlLandedSomewherePublic =
          !viaCurl?.effectiveUrl || (await assertPublicResultUrl(viaCurl.effectiveUrl));
        if (viaCurl && curlLandedSomewherePublic && viaCurl.status >= 200 && viaCurl.status < 400) {
          if (viaCurl.text.includes('<html') || /<body[\s>]/i.test(viaCurl.text)) {
            const parsed = htmlToReadableText(viaCurl.text);
            pageTitle = parsed.title || pageTitle;
            bodyText = parsed.text;
          } else {
            bodyText = viaCurl.text.trim();
          }
          if (bodyText.length >= 120) {
            blocked = false;
            finalUrl = viaCurl.effectiveUrl || finalUrl;
            fetchNote = '(retrieved with the system curl fallback after a direct fetch was blocked)';
          }
        }
      }

      if (blocked || bodyText.length < 120) {
        const proxied = await fetchViaReaderProxy(finalUrl);
        if (proxied) {
          bodyText = proxied;
          blocked = false;
          fetchNote = '(retrieved via a reader proxy after the site blocked direct access)';
        }
      }

      // Give up honestly rather than feeding the model a captcha page.
      if (blocked || !bodyText.trim()) {
        const reason = statusCode ? `HTTP ${statusCode}` : 'network error or timeout';
        return res.json({
          success: false,
          tool: 'fetch_url',
          url: finalUrl,
          error: `Could not read ${finalUrl} (${reason}). The site likely blocks automated access.`,
          output:
            `Could not read ${finalUrl} (${reason}) — the page is behind a bot/security wall or is unreachable.\n` +
            `Do NOT invent its contents. Either try a different link from your web search, or answer from the search snippets and clearly say what you could not verify.`,
        });
      }

      // If a searchQuery was provided: search specifically inside the fetched text
      if (searchQuery && typeof searchQuery === 'string') {
        const q = searchQuery.toLowerCase();
        const sentences = bodyText.split(/(?<=[.!?])\s+/);
        const matchedSentences = [];
        for (let i = 0; i < sentences.length; i++) {
          if (sentences[i].toLowerCase().includes(q)) {
            const context = [
              sentences[i - 1],
              `**${sentences[i].trim()}**`,
              sentences[i + 1],
            ]
              .filter(Boolean)
              .join(' ');
            matchedSentences.push(context);
            if (matchedSentences.length >= 6) break;
          }
        }

        const searchOutput =
          matchedSentences.length > 0
            ? `# Search matches for "${searchQuery}" in ${pageTitle || finalUrl}:\n\n` +
              matchedSentences.map((s, idx) => `${idx + 1}. ... ${s} ...`).join('\n\n')
            : `No specific matches for "${searchQuery}" found in page content. Overview:\n\n${bodyText.slice(0, 4000)}`;

        return res.json({
          success: true,
          tool: 'fetch_url',
          url: finalUrl,
          searchQuery,
          title: pageTitle,
          output: fetchNote ? `${searchOutput}\n\n_${fetchNote}_` : searchOutput,
        });
      }

      const summary = pageTitle
        ? `# ${pageTitle}\n\n${bodyText.slice(0, 9000)}`
        : bodyText.slice(0, 9000);

      return res.json({
        success: true,
        tool: 'fetch_url',
        url: finalUrl,
        title: pageTitle,
        output: fetchNote ? `${summary}\n\n_${fetchNote}_` : summary,
      });
    }

    return res.status(400).json({ error: `Unknown search tool: ${tool}` });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message || 'Search failed' });
  }
}

app.post('/api/search', handleSearchTool);

// Agent mode: workspaces, files, commands, and the agent run itself.
registerAgentRoutes(app, { runSearchTool, resolveProvider: providerWithStoredCredentials });

// A cloud sandbox bills while it is RUNNING, so one left behind after a run is
// pure cost. This sweeper pauses app-managed sandboxes once they go quiet, and
// is what makes "the agent finished, so the sandbox went to sleep" true.
startIdlePauseSweeper({ isBusy: (workspaceId) => _activeRuns.has(workspaceId) });

/**
 * Run one of the read-only web tools and hand back its plain result object.
 *
 * The tool implementations live in `handleSearchTool` and answer through
 * Express's `res`. Rather than duplicate them, this drives that same handler
 * with a stand-in response that captures what it would have sent — so the chat
 * tool loop (which needs the data, not an HTTP response) reuses the exact same
 * search and fetch code path the `/api/search` endpoint exposes.
 *
 * Never throws: a failure comes back as `{ success: false, error }` so the
 * model can see what went wrong and try something else instead of the whole
 * turn dying.
 */
async function runSearchTool(tool, args) {
  let captured = null;
  const fakeRes = {
    _status: 200,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      captured = { status: this._status, body: payload };
      return this;
    },
  };

  try {
    await handleSearchTool({ body: { tool, args: args || {} } }, fakeRes);
  } catch (err) {
    return { success: false, tool, error: err.message || 'Tool execution failed' };
  }

  if (!captured) {
    return { success: false, tool, error: 'Tool produced no result' };
  }
  const body = captured.body || {};
  if (captured.status >= 400) {
    return { success: false, tool, error: body.error || `Tool failed (HTTP ${captured.status})` };
  }
  return body;
}


// Serve static frontend files if built
const distPath = path.join(__dirname, '../dist');
app.use(
  express.static(distPath, {
    /**
     * Vite writes content-hashed file names (index-CGbc8-Ks.js), so those can be
     * cached for a year: a new build changes the name. `index.html` is the
     * opposite — it is what points at the new names, so caching it would keep
     * serving the previous release to a returning browser.
     */
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (name === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/-[A-Za-z0-9_-]{8,}\./.test(name)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

/**
 * Final safety net.
 *
 * Every handler is wrapped above, so any throw or rejected promise lands here.
 * Answering with a JSON 500 is what keeps a bad request from hanging the client
 * forever — the client gets a normal JSON error it can show instead.
 */
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  // body-parser tags its own errors with a 4xx status (malformed JSON, payload
  // too large). Honour it instead of reporting a server fault for a bad request.
  const status = Number(err?.status || err?.statusCode) || 500;
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    error: err?.message || 'Internal server error',
  });
});

/**
 * Unknown API route → JSON, never HTML.
 *
 * Without this, Express's default handler answers an unknown /api/* path with an
 * HTML error page. Every client here parses API responses as JSON, so that page
 * becomes `Unexpected token '<'` — an error message about the parser instead of
 * about the route that does not exist. Registered before the SPA catch-all, which
 * would otherwise serve index.html for an API typo.
 */
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Unknown API route: ${req.method} ${req.originalUrl}`,
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = path.join(distPath, 'index.html');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send('API Server running. Start Vite for frontend development.');
    }
  });
});

const listen = () => console.log(`Backend server running on http://localhost:${PORT}`);
// The Vite dev server proxies /api requests locally. Keep its backend private by
// default in dev so the exposed Vite preview is the only public entry point.
if (process.env.DANAV_HOST) app.listen(PORT, process.env.DANAV_HOST, listen);
else app.listen(PORT, listen);
