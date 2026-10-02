/**
 * HTTP surface of Agent mode, mounted at /api/agent.
 *
 *   GET    /config                      what is available (never the key itself)
 *   POST   /novita/key  | DELETE        save / forget the Novita key
 *   GET    /workspaces                  list
 *   POST   /workspaces                  create (sandbox or local)
 *   PATCH  /workspaces/:id              rename, toggle auto-run
 *   DELETE /workspaces/:id              remove (kills the sandbox)
 *   GET    /workspaces/:id/tree?path=   one folder level, for the Files panel
 *   GET    /workspaces/:id/file?path=   one file's text, for the Files panel
 *   POST   /approvals/:key              allow / deny a pending command
 *   POST   /chat                        run the agent (Server-Sent Events)
 */
import express from 'express';
import {
  agentRequestGuard, allowAnyLocalPath, clearNovitaKey, getNovitaKey, limits, novitaKeySource,
  saveNovitaKey, workspacesDir,
} from './config.js';
import { resolveApproval } from './approvals.js';
import { runAgent } from './loop.js';
import { clearNotes, readNotes, removeNotes } from './memory.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { createRedactor, genId } from './util.js';
import { WorkspaceError } from './workspaces/base.js';
import {
  createWorkspace, deleteWorkspace, listWorkspaceInfos, openWorkspace, updateWorkspace,
} from './workspaces/index.js';
import { loadNovitaSdk } from './workspaces/sandbox.js';

const HEARTBEAT_MS = 15_000;
const MAX_VIEW_CHARS = 400_000;

/** One run per workspace at a time: two agents editing the same files would corrupt each other. */
const activeRuns = new Map(); // workspaceId -> { runId, controller }

const statusFor = (err) => {
  if (!(err instanceof WorkspaceError)) return 500;
  if (err.code === 'not_found') return 404;
  if (err.code === 'sandbox_error' || err.code === 'timeout') return 502;
  if (err.code === 'auth') return 401;
  return 400;
};

function sendError(res, err) {
  const status = statusFor(err);
  if (status === 500) console.error('[agent] route error:', err);
  if (res.headersSent) return res.end();
  return res.status(status).json({ success: false, error: err?.message || 'Something went wrong.', code: err?.code });
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

export function registerAgentRoutes(app, { runSearchTool }) {
  const router = express.Router();
  router.use(agentRequestGuard);

  // ------------------------------------------------------------------ config
  router.get('/config', (req, res) => {
    res.json({
      success: true,
      novita: { configured: Boolean(getNovitaKey()), source: novitaKeySource() },
      local: { workspacesDir: workspacesDir(), allowAnyPath: allowAnyLocalPath(), platform: process.platform },
      limits: { maxSteps: limits.maxSteps(), commandTimeoutSeconds: Math.round(limits.commandTimeoutMs() / 1000) },
      tools: TOOL_DEFINITIONS.map((d) => d.function.name),
    });
  });

  router.post('/novita/key', wrap(async (req, res) => {
    const apiKey = String(req.body?.apiKey || '').trim();
    if (apiKey.length < 12) return res.status(400).json({ success: false, error: 'That does not look like a Novita API key.' });
    // Prove the key works before keeping it.
    try {
      const { Sandbox } = await loadNovitaSdk();
      await Sandbox.list({ apiKey, limit: 1 }).nextItems();
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      const name = err?.constructor?.name || '';
      if (name === 'AuthenticationError' || /401|unauthor|invalid/i.test(String(err?.message))) {
        return res.status(400).json({ success: false, error: 'Novita rejected this key. Copy it again from novita.ai → Key Management.' });
      }
      return res.status(502).json({ success: false, error: `Could not reach Novita to check the key: ${err?.message || 'network error'}` });
    }
    saveNovitaKey(apiKey);
    res.json({ success: true, configured: true, source: novitaKeySource() });
  }));

  router.delete('/novita/key', (req, res) => {
    clearNovitaKey();
    res.json({ success: true, configured: Boolean(getNovitaKey()), source: novitaKeySource() });
  });

  // -------------------------------------------------------------- workspaces
  router.get('/workspaces', (req, res) => res.json({ success: true, workspaces: listWorkspaceInfos() }));

  router.post('/workspaces', wrap(async (req, res) => {
    const ws = await createWorkspace({
      name: req.body?.name,
      kind: req.body?.kind,
      path: req.body?.path,
      autoRun: typeof req.body?.autoRun === 'boolean' ? req.body.autoRun : undefined,
    });
    res.json({ success: true, workspace: ws.info() });
  }));

  router.patch('/workspaces/:id', wrap(async (req, res) => {
    res.json({ success: true, workspace: updateWorkspace(req.params.id, req.body || {}) });
  }));

  router.delete('/workspaces/:id', wrap(async (req, res) => {
    if (activeRuns.has(req.params.id)) throw new WorkspaceError('The agent is running in this workspace. Stop it first.', 'busy');
    await deleteWorkspace(req.params.id, { deleteFiles: req.query.deleteFiles === '1' });
    res.json({ success: true });
  }));

  router.get('/workspaces/:id/tree', wrap(async (req, res) => {
    const ws = await openWorkspace(req.params.id);
    await ws.init();
    const abs = typeof ws.safePath === 'function' ? await ws.safePath(req.query.path || '.') : ws.resolve(req.query.path || '.');
    const { entries, truncated } = await ws.listTree(abs, { depth: 1, maxEntries: 500 });
    const base = ws.displayPath(abs);
    res.json({
      success: true,
      path: base,
      truncated,
      entries: entries.map((e) => ({
        name: e.path,
        path: base === '.' ? e.path : `${base}/${e.path}`,
        type: e.type,
        size: e.size,
      })),
    });
  }));

  router.get('/workspaces/:id/file', wrap(async (req, res) => {
    const ws = await openWorkspace(req.params.id);
    await ws.init();
    const abs = typeof ws.safePath === 'function' ? await ws.safePath(req.query.path || '') : ws.resolve(req.query.path || '');
    const r = await ws.readText(abs);
    const redact = createRedactor();
    const text = redact(r.text);
    res.json({
      success: true,
      path: ws.displayPath(abs),
      size: r.size,
      binary: r.binary,
      truncated: text.length > MAX_VIEW_CHARS,
      text: text.length > MAX_VIEW_CHARS ? text.slice(0, MAX_VIEW_CHARS) : text,
    });
  }));

  // ------------------------------------------------------------------ memory
  router.get('/workspaces/:id/memory', wrap(async (req, res) => {
    await openWorkspace(req.params.id); // 404 for an unknown workspace
    res.json({ success: true, notes: readNotes(req.params.id) });
  }));

  router.delete('/workspaces/:id/memory/:noteId', wrap(async (req, res) => {
    await openWorkspace(req.params.id);
    res.json({ success: true, removed: removeNotes(req.params.id, { id: req.params.noteId }), notes: readNotes(req.params.id) });
  }));

  router.delete('/workspaces/:id/memory', wrap(async (req, res) => {
    await openWorkspace(req.params.id);
    clearNotes(req.params.id);
    res.json({ success: true, notes: [] });
  }));

  // --------------------------------------------------------------- approvals
  router.post('/approvals/:key', wrap(async (req, res) => {
    const allow = req.body?.allow === true;
    if (allow && req.body?.always === true && typeof req.body?.workspaceId === 'string') {
      try { updateWorkspace(req.body.workspaceId, { autoRun: true }); } catch { /* workspace gone; still answer the prompt */ }
    }
    const found = resolveApproval(req.params.key, allow);
    res.json({ success: found, error: found ? undefined : 'That request is no longer waiting (it was answered, or the run ended).' });
  }));

  // -------------------------------------------------------------------- chat
  router.post('/chat', async (req, res) => {
    const { provider, model, thinkingLevel, messages, workspaceId, activity } = req.body || {};
    if (!provider || typeof provider !== 'object') return res.status(400).json({ error: 'Provider configuration is missing.' });
    if (provider.apiType === 'mock') {
      return res.status(400).json({ error: 'The Demo provider cannot run the agent. Pick a real model (it must support tool calling).' });
    }
    if (!model) return res.status(400).json({ error: 'Model selection is missing.' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Messages array is required.' });
    if (!workspaceId) return res.status(400).json({ error: 'Pick or create a workspace first.' });
    if (activeRuns.has(workspaceId)) {
      return res.status(409).json({ error: 'Another agent run is already using this workspace. Wait for it to finish or stop it.' });
    }

    // Anything that can fail up front (bad key, sandbox unreachable, workspace gone) is
    // reported as a plain HTTP error the UI understands, before the stream starts.
    let ws;
    try {
      ws = await openWorkspace(workspaceId);
      await ws.init();
    } catch (err) {
      return sendError(res, err);
    }
    if (activeRuns.has(workspaceId)) return res.status(409).json({ error: 'Another agent run is already using this workspace.' });

    const runId = genId('run');
    const controller = new AbortController();
    activeRuns.set(workspaceId, { runId, controller });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    // Long tool calls (an npm install) can be silent for minutes; proxies drop idle streams.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      await runAgent({
        provider,
        model,
        thinkingLevel,
        history: messages,
        activity: Array.isArray(activity) ? activity.filter((l) => typeof l === 'string').slice(-60) : [],
        workspace: ws,
        runSearchTool,
        send,
        signal: controller.signal,
        runId,
      });
    } catch (err) {
      console.error('[agent] unexpected:', err);
      send({ error: err?.message || 'The agent crashed.' });
    } finally {
      clearInterval(heartbeat);
      activeRuns.delete(workspaceId);
      ws.notify = () => {};
      send({ done: true });
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  app.use('/api/agent', router);
  return router;
}

export const _activeRuns = activeRuns;
