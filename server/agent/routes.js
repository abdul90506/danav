/**
 * HTTP surface of Agent mode, mounted at /api/agent.
 *
 *   GET    /config                      what is available (never the key itself)
 *   POST   /novita/key  | DELETE        save / forget the Novita key
 *   GET    /workspaces                  list
 *   POST   /workspaces                  create (sandbox or local)
 *   PATCH  /workspaces/:id              rename, toggle auto-run / auto-pause
 *   DELETE /workspaces/:id              remove (kills the sandbox)
 *   GET    /workspaces/:id/tree?path=   one folder level, for the Files panel
 *   GET    /workspaces/:id/file?path=   one file's text, for the Files panel
 *   POST   /workspaces/:id/wake         resume the sandbox and reset the idle clock
 *   GET    /sandboxes                   EVERY sandbox in the Novita account
 *   POST   /sandboxes/:id/pause         pause one
 *   POST   /sandboxes/:id/resume        wake one
 *   DELETE /sandboxes/:id               terminate one for good
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
import { readRunJournal } from './journal.js';
import { noteRunFinished, touch } from './sandboxActivity.js';
import {
  killSandboxById, listAccountSandboxes, pauseSandboxById, resumeSandboxById, workspaceSandboxStatus,
} from './sandboxAdmin.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { createSkillRegistry } from './skills.js';
import { deleteChatTraces, listRuns, listTracedChats, readAllRuns, readRun } from './trace.js';
import { analyzeChat, analyzeRun } from './traceAnalysis.js';
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

export function registerAgentRoutes(app, {
  runSearchTool,
  resolveProvider = (provider) => provider,
  resolveSummaryModel = (_provider, _model) => null,
}) {
  const router = express.Router();
  router.use(agentRequestGuard);

  // ------------------------------------------------------------------ config
  router.get('/config', (req, res) => {
    res.json({
      success: true,
      novita: { configured: Boolean(getNovitaKey()), source: novitaKeySource() },
      local: { workspacesDir: workspacesDir(), allowAnyPath: allowAnyLocalPath(), platform: process.platform },
      limits: { maxSteps: limits.maxSteps(), commandTimeoutSeconds: Math.round(limits.commandTimeoutMs() / 1000) },
      // The UI shows these so "it paused on its own" is never a mystery.
      sandbox: {
        idlePauseSeconds: Math.round(limits.sandboxIdlePauseMs() / 1000),
        runGraceSeconds: Math.round(limits.sandboxRunGraceMs() / 1000),
        timeoutMinutes: Math.round(limits.sandboxTimeoutMs() / 60_000),
      },
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

  /**
   * A flat list of the workspace's files, for the composer's @-mention picker.
   *
   * The tree endpoint is one folder deep on purpose — it backs a browsable
   * panel. Mentioning a file is the opposite interaction: you know roughly what
   * it is called and do not want to walk there, so the whole list is ranked
   * client-side as you type. An empty pattern means "everything", which is what
   * the picker opens with.
   */
  router.get('/workspaces/:id/files', wrap(async (req, res) => {
    const ws = await openWorkspace(req.params.id);
    await ws.init();
    const abs = ws.resolve('.');
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
    const { files, truncated } = await ws.findFiles({
      pattern: String(req.query.pattern || ''),
      path: abs,
      maxResults: limit,
    });
    res.json({ success: true, files, truncated });
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

  /**
   * The skills this workspace can run, for the composer's picker.
   *
   * The same registry the agent uses, so what the user sees in the "/" menu is
   * exactly what `load_skill` will accept — built-ins plus any SKILL.md the
   * project carries.
   */
  router.get('/workspaces/:id/skills', wrap(async (req, res) => {
    const ws = await openWorkspace(req.params.id);
    await ws.init();
    const registry = createSkillRegistry(ws, createRedactor());
    let skills = [];
    try {
      skills = await registry.discover();
    } catch {
      // A picker is not worth failing a request over; an empty list is honest.
      skills = [];
    }
    res.json({ success: true, skills });
  }));

  // ------------------------------------------------------------------- traces
  /**
   * The flight recorder, read back.
   *
   * Everything a run was given and everything it did, per chat: the exact
   * instructions, the tools it was offered, every call with its arguments and
   * result, each model the fallback moved it to, the budgets, the errors.
   */
  router.get('/traces', wrap(async (req, res) => {
    const chatId = String(req.query.chatId || '').trim();
    if (!chatId) return res.json({ success: true, chats: listTracedChats() });
    return res.json({ success: true, chatId, runs: listRuns(chatId) });
  }));

  /**
   * The same traces, read as a list of faults.
   *
   * What actually leads to a fix is not the timeline but "this tool failed the
   * same way four times" and "this file was read five times in one run".
   */
  router.get('/traces/:chatId/analysis', wrap(async (req, res) => {
    const runs = readAllRuns(req.params.chatId);
    return res.json({
      success: true,
      chatId: req.params.chatId,
      runsAnalysed: runs.length,
      findings: analyzeChat(runs),
    });
  }));

  router.get('/traces/:chatId/:runId/analysis', wrap(async (req, res) => {
    const run = readRun(req.params.chatId, req.params.runId);
    if (!run) return res.status(404).json({ success: false, error: 'No trace for that run' });
    return res.json({ success: true, findings: analyzeRun(run) });
  }));

  router.get('/traces/:chatId/:runId', wrap(async (req, res) => {
    const found = readRun(req.params.chatId, req.params.runId);
    if (!found) return res.status(404).json({ success: false, error: 'No trace for that run' });
    return res.json({ success: true, ...found });
  }));

  router.delete('/traces/:chatId', wrap(async (req, res) => {
    return res.json({ success: deleteChatTraces(req.params.chatId) });
  }));

  // ------------------------------------------------------------------ memory
  router.get('/workspaces/:id/memory', wrap(async (req, res) => {
    await openWorkspace(req.params.id); // 404 for an unknown workspace
    res.json({ success: true, notes: readNotes(req.params.id), runs: readRunJournal(req.params.id, 12) });
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

  // ----------------------------------------------------------------- sandboxes
  // The account-wide view. A Novita account collects sandboxes from earlier
  // sessions and deleted workspaces, and every running one costs money — so the
  // user has to be able to see and manage ALL of them, not just the ones this
  // app still remembers.

  router.get('/sandboxes', wrap(async (req, res) => {
    if (!getNovitaKey()) return res.json({ success: true, configured: false, sandboxes: [], totals: { all: 0, running: 0, paused: 0, orphans: 0 } });
    const state = req.query.state === 'running' || req.query.state === 'paused' ? req.query.state : undefined;
    res.json({ success: true, configured: true, ...(await listAccountSandboxes({ state })) });
  }));

  /** The active workspace's own sandbox: drives the status chip in the UI. */
  router.get('/sandboxes/status', wrap(async (req, res) => {
    const workspaceId = String(req.query.workspaceId || '');
    if (!workspaceId) throw new WorkspaceError('workspaceId is required.', 'bad_request');
    // A local workspace, or one with no key yet, still gets an honest answer.
    res.json({
      success: true,
      configured: Boolean(getNovitaKey()),
      status: await workspaceSandboxStatus(workspaceId),
    });
  }));

  router.post('/sandboxes/:id/pause', wrap(async (req, res) => {
    res.json({ success: true, ...(await pauseSandboxById(req.params.id)) });
  }));

  router.post('/sandboxes/:id/resume', wrap(async (req, res) => {
    res.json({ success: true, ...(await resumeSandboxById(req.params.id)) });
  }));

  /** Terminates the sandbox and destroys its disk. The UI confirms first. */
  router.delete('/sandboxes/:id', wrap(async (req, res) => {
    res.json({ success: true, ...(await killSandboxById(req.params.id)) });
  }));

  /**
   * "I am about to use this workspace" — resume the sandbox if it is asleep and
   * reset the idle clock, so the preview the user just clicked actually answers.
   */
  router.post('/workspaces/:id/wake', wrap(async (req, res) => {
    const ws = await openWorkspace(req.params.id);
    touch(ws.id);
    if (ws.kind === 'sandbox' && ws.record.sandboxId) await ws.resume();
    res.json({ success: true, sandboxId: ws.record.sandboxId || null });
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

  // A provider/model switch during the busy backoff has to stop the old upstream
  // loop and wait for its workspace lock to release before the task is resumed.
  router.post('/workspaces/:id/stop', wrap(async (req, res) => {
    const run = activeRuns.get(req.params.id);
    if (!run) return res.json({ success: true, active: false });
    run.controller.abort();
    await run.finished;
    return res.json({ success: true, active: false });
  }));

  // -------------------------------------------------------------------- chat
  router.post('/chat', async (req, res) => {
    const { provider: suppliedProvider, model, thinkingLevel, messages, workspaceId, taskId, activity, resume } = req.body || {};
    const provider = resolveProvider(suppliedProvider);
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
    let markRunFinished;
    const finished = new Promise((resolve) => { markRunFinished = resolve; });
    activeRuns.set(workspaceId, { runId, controller, finished });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const streamOpen = () => !res.writableEnded && !res.destroyed && res.writable;
    const send = (obj) => {
      if (!streamOpen()) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // Compression/proxy middleware may otherwise coalesce successive SSE writes.
      // Push every real event immediately; this changes delivery timing, not content.
      res.flush?.();
    };
    // Long tool calls (an npm install) can be silent for minutes; proxies drop idle streams.
    const heartbeat = setInterval(() => {
      if (!streamOpen()) return;
      res.write(': ping\n\n');
      res.flush?.();
    }, HEARTBEAT_MS);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let summarySelection = null;
    try { summarySelection = resolveSummaryModel(provider, model); } catch { /* summary notes fall back to the active model */ }

    try {
      await runAgent({
        provider,
        model,
        summaryProvider: summarySelection?.provider || provider,
        summaryModel: summarySelection?.model || model,
        thinkingLevel,
        history: messages,
        taskId: typeof taskId === 'string' ? taskId.slice(0, 200) : '',
        activity: Array.isArray(activity) ? activity.filter((l) => typeof l === 'string').slice(-60) : [],
        workspace: ws,
        runSearchTool,
        send,
        signal: controller.signal,
        runId,
        /** This request continues the previous run rather than starting a new one. */
        resume: resume === true,
      });
    } catch (err) {
      console.error('[agent] unexpected:', err);
      send({ error: err?.message || 'The agent crashed.' });
    } finally {
      clearInterval(heartbeat);
      activeRuns.delete(workspaceId);
      markRunFinished?.();
      // The run is over. Start the short "finished" clock: if nothing else happens
      // in the workspace, the idle sweeper pauses the sandbox and the meter stops.
      noteRunFinished(workspaceId);
      ws.notify = () => {};
      send({ done: true });
      if (streamOpen()) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  app.use('/api/agent', router);
  return router;
}

export const _activeRuns = activeRuns;
