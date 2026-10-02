/**
 * The agent loop: ask the model, run the tools it asks for, show every step to
 * the chat as it happens, feed the results back, repeat until it answers.
 *
 * Everything the user sees is an event passed to `send`:
 *   { content } / { thinking }                      streamed text
 *   { agent: { type: 'run_start' | 'action_start' | 'action_update' |
 *                    'action_end' | 'notice' | 'run_end', ... } }
 *   { status } / { error }
 */
import { requestApproval, cancelApprovalsFor } from './approvals.js';
import { limits } from './config.js';
import { LlmError, streamCompletion } from './llm.js';
import { buildSystemPrompt, formatSnapshot } from './prompt.js';
import { buildToolset, READ_ONLY_TOOLS } from './tools.js';
import { splitLines } from './textops.js';
import { memoryForPrompt } from './memory.js';
import { createRedactor, genId, truncateMiddle } from './util.js';

const PROGRESS_THROTTLE_MS = 140;
const OUTPUT_FLUSH_MS = 120;
/** How many read-only calls of one round may run at the same time. */
const MAX_PARALLEL = 6;

// ---------------------------------------------------------------------------
// Replaying a file that arrived all at once
// ---------------------------------------------------------------------------
// Some providers hand over a whole tool call in ONE chunk (measured on Vyce/agnes:
// 1829 characters of write_file arguments in a single frame after 33s of reasoning).
// Nothing was wrong with the model — but the chat then shows a 300-line file popping
// into existence, and the "+N" counter has nothing to count. So when a call like that
// is detected, its body is replayed over a moment: the same partial-argument reader
// that follows a real token stream is fed growing prefixes of the finished JSON, and
// the row counts up and scrolls its last lines exactly as if it were being typed.
// The tool itself still runs at full speed — only the display is paced.

/** Calls worth replaying: the ones whose body is worth watching. */
const REVEAL_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'multi_edit']);
/** Below this the file is on screen before anyone could read it anyway. */
const REVEAL_MIN_CHARS = 420;
const REVEAL_TICK_MS = 30;
/**
 * How long after a call's first frame a fully-formed body still counts as "arrived all at once".
 * A streamed file takes seconds to arrive; a dumped one is complete in the same millisecond.
 */
const ONE_SHOT_WINDOW_MS = 150;
/** ~220 characters per step, clamped: a small file flashes by, a big one takes ~1.4s. */
const revealSteps = (len) => Math.max(6, Math.min(45, Math.round(len / 220)));

/** Did the model finish this call in the frame we just saw? */
const isCompleteJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Offset just past the opening quote/bracket of the body, so the path shows at once. */
const bodyStartIndex = (text) => {
  const m = /"(?:content|new_string|old_string|edits)"\s*:\s*["[]/.exec(text);
  return m ? m.index + m[0].length : 0;
};

/**
 * A fresh progress tracker for a replay. It is handed the path up front: the model may put
 * "content" before "path", and without the path the tracker cannot know what is on disk — an
 * overwrite would then replay with no numbers at all.
 */
function replayTracker(tools, name, argsText) {
  let path;
  try {
    path = JSON.parse(argsText)?.path;
  } catch {
    /* not complete after all — the tracker will pick the path up if it arrives */
  }
  return tools.progressTracker(name, typeof path === 'string' && path ? { path } : {});
}

/**
 * Walk the finished arguments from "body just opened" to "whole call", publishing the
 * progress of each prefix. @returns the number of updates sent.
 */
async function replayBody({ text, tracker, send, id, signal, writer }) {
  const from = bodyStartIndex(text);
  const steps = revealSteps(text.length);
  let sent = 0;
  for (let s = 1; s <= steps; s++) {
    if (signal?.aborted) return sent;
    const cut = from + Math.round(((text.length - from) * s) / steps);
    const { progress, body } = tracker.update(text.slice(0, cut));
    // The lines go on disk FIRST, and the number published is the one the file really has: the
    // count in the chat is a reading of the file, never a promise about it.
    let real = null;
    if (writer) real = await writer.push(body, { force: s === steps }); // the last line always lands
    if (progress) {
      if (real !== null && progress.added > real) progress.added = real;
      send({ agent: { type: 'action_update', id, patch: { progress } } });
      sent++;
    }
    if (s < steps) await new Promise((r) => setTimeout(r, REVEAL_TICK_MS));
  }
  if (writer) writer.push(text ? JSON.parse(text).content ?? '' : '', { force: true });
  return sent;
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

const sizeOf = (m) =>
  (m.content ? String(m.content).length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

/** write_file bodies dominate the context; once written, the model can just re-read the file. */
function elideOldToolArguments(messages, keepLast = 3) {
  const idx = messages.map((m, i) => (m.role === 'assistant' && m.tool_calls?.length ? i : -1)).filter((i) => i >= 0);
  const protect = new Set(idx.slice(-keepLast));
  for (const i of idx) {
    if (protect.has(i)) continue;
    for (const tc of messages[i].tool_calls) {
      const raw = tc.function.arguments || '';
      if (raw.length < 400) continue;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      if (!parsed || typeof parsed !== 'object') {
        tc.function.arguments = '{}';
        continue;
      }
      for (const key of ['content', 'old_string', 'new_string']) {
        if (typeof parsed[key] === 'string' && parsed[key].length > 200) parsed[key] = '[omitted from history — it was applied]';
      }
      if (Array.isArray(parsed.edits) && JSON.stringify(parsed.edits).length > 400) {
        parsed.edits = [{ old_string: '[omitted]', new_string: '[omitted]' }];
      }
      tc.function.arguments = JSON.stringify(parsed);
    }
  }
}

/**
 * Keep the conversation inside the model's context budget:
 *   1. elide the bodies of old tool calls and the output of old tool results
 *   2. if still too big, drop the oldest whole rounds
 * The system prompt, the user's turns and the most recent rounds always survive.
 */
export function pruneMessages(messages, budgetChars) {
  const total = () => messages.reduce((n, m) => n + sizeOf(m), 0);
  if (total() <= budgetChars) return { pruned: false };

  elideOldToolArguments(messages);

  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const protect = new Set(toolIdx.slice(-8));
  let cur = total();
  for (const i of toolIdx) {
    if (cur <= budgetChars) break;
    if (protect.has(i)) continue;
    const before = sizeOf(messages[i]);
    if (before <= 300) continue;
    messages[i].content = `[older tool output elided to save context: ${before} characters]`;
    cur -= before - messages[i].content.length;
  }

  let dropped = 0;
  while (total() > budgetChars) {
    const first = messages.findIndex((m, i) => i > 0 && m.role === 'assistant' && m.tool_calls?.length);
    if (first === -1) break;
    const roundsLeft = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    if (roundsLeft <= 3) break;
    let end = first + 1;
    while (end < messages.length && messages[end].role === 'tool') end++;
    messages.splice(first, end - first);
    dropped++;
  }
  return { pruned: true, droppedRounds: dropped };
}

const cleanHistory = (history) =>
  (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .filter((m) => m.role === 'user' || m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.provider  { baseUrl, apiKey }
 * @param {string} o.model
 * @param {string} [o.thinkingLevel]
 * @param {Array}  o.history   prior turns, [{ role, content }]
 * @param {string[]} [o.activity] one-line summaries of earlier actions
 * @param {import('./workspaces/base.js').BaseWorkspace} o.workspace
 * @param {Function} o.runSearchTool
 * @param {(event: object) => void} o.send
 * @param {AbortSignal} o.signal
 * @param {string} o.runId
 */
export async function runAgent({
  provider, model, thinkingLevel, history, activity, workspace, runSearchTool, send, signal, runId,
}) {
  const redact = createRedactor([provider.apiKey]);
  const tools = buildToolset({ workspace, runSearchTool, redact });
  const state = {
    readFiles: new Set(), plan: [], changed: new Map(), singleEdits: new Map(),
    /** Files being written straight to disk while the model writes them (see tools.liveWrite). */
    liveWriters: [], committedWrites: new Set(),
  };
  const startedAt = Date.now();
  const deadline = startedAt + limits.maxRunMs();
  const maxSteps = limits.maxSteps();
  const stats = { steps: 0, toolCalls: 0 };
  let stopReason = 'completed';

  workspace.notify = (message) => send({ agent: { type: 'notice', message } });
  send({ agent: { type: 'run_start', runId, workspace: workspace.info() } });
  send({ status: 'Working…' });

  try {
    // ---- context ------------------------------------------------------------
    let snapshot = '';
    let notes = '';
    try {
      const { entries, truncated } = await workspace.listTree(workspace.root, { depth: 2, maxEntries: 120 });
      snapshot = formatSnapshot(entries, truncated);
      const agentsMd = workspace.resolve('AGENTS.md');
      if ((await workspace.stat(agentsMd)).type === 'file') {
        const r = await workspace.readText(agentsMd, { maxBytes: 200_000 });
        if (!r.binary) notes = truncateMiddle(redact(r.text), 3000, 'notes');
      }
    } catch (err) {
      snapshot = `(could not list the workspace: ${err.message})`;
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt({ workspace, snapshot, notes, memory: redact(memoryForPrompt(workspace.id)), activity }) },
      ...cleanHistory(history),
    ];

    const failCounts = new Map();
    let wrapUp = null; // set once a budget runs out or the model keeps failing
    let nudged = false;

    // ---- rounds -------------------------------------------------------------
    for (;;) {
      if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

      if (!wrapUp && stats.steps >= maxSteps) {
        wrapUp = 'step_limit';
        messages.push({
          role: 'user',
          content: '[system notice] You have used all the steps allowed for one run. Do NOT call any more tools. Summarise what is done, what is left, and tell the user they can reply "continue" to keep going.',
        });
      } else if (!wrapUp && Date.now() > deadline) {
        wrapUp = 'time_limit';
        messages.push({
          role: 'user',
          content: '[system notice] The time allowed for one run is up. Do NOT call any more tools. Summarise what is done and what is left.',
        });
      }
      stopReason = wrapUp || stopReason;

      const prune = pruneMessages(messages, limits.contextChars());
      if (prune.pruned) send({ status: 'Trimming old context…' });

      stats.steps++;
      const live = new Map(); // tool-call slot -> { uiId, lastSent, lastKey }
      const useTools = !wrapUp;

      /**
       * The one live writer for this call. Created through a single promise, so a call can never end
       * up with two writers fighting over the same file — one of them would "roll back" the other's
       * finished work when the run ends.
       */
      const writerFor = (st, pathText) => {
        // Never discard a creation that is already in flight: the caller would otherwise believe
        // there is no writer while one is about to appear and start writing.
        if (!pathText) return st.writerPromise || Promise.resolve(null);
        if (!st.writerPromise) {
          st.writerPromise = tools
            .liveWrite(pathText)
            .then((w) => {
              st.writer = w;
              if (w) state.liveWriters.push(w);
              return w;
            })
            .catch(() => null);
        }
        return st.writerPromise;
      };

      const onDelta = (slot) => {
        if (!useTools || !slot.name) return;
        const now = Date.now();
        let st = live.get(slot);
        if (!st) {
          st = {
            uiId: genId('a'), firstAt: now, lastSent: now, lastKey: '',
            deltas: 0, published: false, replay: null, writer: null, writerPending: false,
            tracker: tools.progressTracker(slot.name),
          };
          live.set(slot, st);
        }
        st.deltas++;
        const { args, progress, body } = st.tracker.update(slot.args);


        // A body that lands WHOLE within a blink of the call starting (Vyce/agnes send one frame;
        // Gemini and some proxies send the name and then the entire body) has nothing to stream.
        // Hold its numbers back and replay it while it is written — but only while nothing has been
        // shown yet, so a count the user is already watching is never restarted from zero.
        const wholeAtOnce =
          REVEAL_TOOLS.has(slot.name) && !st.published && !st.replay &&
          slot.args.length >= REVEAL_MIN_CHARS && isCompleteJson(slot.args) &&
          now - st.firstAt < ONE_SHOT_WINDOW_MS;
        if (wholeAtOnce) {
          st.replay = { text: slot.args, tracker: replayTracker(tools, slot.name, slot.args) };
          if (st.deltas === 1) send({ agent: { type: 'action_start', id: st.uiId, tool: slot.name, args } });
          return;
        }
        st.replay = null; // it turned out to be a real stream after all: follow it as usual

        // Following a real stream: the file starts existing the moment its path is known, and every
        // line that arrives after that lands on disk as it arrives. A replay paces its own writes.
        if (slot.name === 'write_file' && body !== undefined && args.path) {
          st.lastBody = body;
          writerFor(st, args.path).then((w) => {
            if (w && !st.replay) w.push(st.lastBody || '');
          });
        }
        // A live stream cannot wait for the disk, so the count is capped at what the file really
        // holds: the chat may lag behind the model, but it never runs ahead of the file.
        if (progress && st.writer) {
          const real = st.writer.linesOnDisk();
          if (progress.added > real) progress.added = real;
        }

        if (st.deltas === 1) {
          send({ agent: { type: 'action_start', id: st.uiId, tool: slot.name, args, ...(progress ? { progress } : {}) } });
          if (progress) st.published = true;
          st.lastSent = now;
          return;
        }
        if (now - st.lastSent < PROGRESS_THROTTLE_MS) return;
        const key = JSON.stringify([args, progress && [progress.added, progress.removed, progress.tail]]);
        if (key === st.lastKey) return;
        st.lastKey = key;
        st.lastSent = now;
        if (progress) st.published = true;
        send({ agent: { type: 'action_update', id: st.uiId, patch: { args, ...(progress ? { progress } : {}) } } });
      };

      const round = await streamCompletion({
        provider,
        model,
        thinkingLevel,
        messages,
        tools: useTools ? tools.definitions : undefined,
        signal,
        onText: (t) => send({ content: t }),
        onThinking: (t) => send({ thinking: t }),
        onToolDelta: (_i, slot) => onDelta(slot),
        onRetry: ({ delayMs, reason }) => send({ status: `Provider busy (${reason}) — retrying in ${Math.round(delayMs / 1000)}s…` }),
      });
      send({ status: 'Working…' });

      const calls = useTools ? round.toolCalls.filter((c) => c.name) : [];

      // ---- the model is done talking -----------------------------------------
      if (calls.length === 0) {
        const said = round.text.trim();
        if (!said && !wrapUp && stats.toolCalls > 0 && !nudged) {
          // It acted and then fell silent. The user must not be left guessing.
          nudged = true;
          messages.push({
            role: 'user',
            content: '[system notice] You finished without a message. Briefly tell the user, in their language, what you did and the result.',
          });
          continue;
        }
        break;
      }

      // ---- echo the assistant turn, then run each tool -------------------------
      const prepared = calls.map((slot) => {
        const st = live.get(slot) || {
          uiId: genId('a'), firstAt: Date.now(), lastSent: 0, lastKey: '',
          deltas: 0, published: false, replay: null, writer: null, writerPending: false,
          tracker: tools.progressTracker(slot.name),
        };
        const isNew = !live.has(slot);
        live.set(slot, st);
        return { slot, st, isNew, modelId: slot.id || st.uiId };
      });

      messages.push({
        role: 'assistant',
        content: round.text || null,
        tool_calls: prepared.map(({ slot, modelId }) => {
          let argText = slot.args || '{}';
          try { JSON.parse(argText); } catch { argText = '{}'; } // a broken blob would poison the next request
          return {
            id: modelId,
            type: 'function',
            function: { name: slot.name, arguments: argText },
            ...(slot.extra_content ? { extra_content: slot.extra_content } : {}),
          };
        }),
      });

      // Tools run one after another. Those still waiting their turn are 'queued' (muted),
      // so a shimmering row always means "working on this right now".
      for (const [i, p] of prepared.entries()) {
        if (p.isNew) continue;
        // The model has finished writing every call: show each one's FINAL numbers right away
        // (the throttle may have swallowed the last few lines), and mark those still waiting as queued.
        // A call queued for replay keeps its numbers back — they will be counted up as it is written.
        const patch = { ...(i > 0 ? { status: 'queued' } : {}) };
        if (!p.st.replay) {
          const { progress } = p.st.tracker.update(p.slot.args);
          if (progress) patch.progress = progress;
        }
        if (Object.keys(patch).length) send({ agent: { type: 'action_update', id: p.st.uiId, patch } });
      }

      /**
       * Run one tool call. The chat is told right away when it ends (action_end); the bookkeeping that must
       * happen in order — failure streaks, what the model reads back — is done afterwards, in `settle`.
       */
      const execute = async ({ slot, st, isNew, modelId }) => {
        const id = st.uiId;
        const name = slot.name;
        stats.toolCalls++;

        let args = {};
        let argError = null;
        let argsTruncated = false;
        try {
          args = slot.args.trim() ? JSON.parse(slot.args) : {};
          if (!args || typeof args !== 'object' || Array.isArray(args)) argError = 'Arguments must be a JSON object.';
        } catch (err) {
          // A provider can hand us mangled JSON; recover what the model actually wrote before
          // declaring the call dead. A call cut off by the OUTPUT LIMIT is left to the salvage path
          // below, which has its own, tested, carry-on-with-append_file flow.
          const recovered = round.finishReason === 'length' ? null : tools.recoverArgs(name, slot.args);
          if (recovered) {
            args = recovered.args;
            argsTruncated = recovered.truncated;
          } else {
            argError =
              round.finishReason === 'length'
                ? 'Your tool call was cut off because the output limit was reached, so its JSON is incomplete. Send a smaller call — for big files, write them in several smaller files.'
                : `The arguments are not valid JSON (${err.message}). Send a single valid JSON object.`;
          }
        }

        const shownArgs = argError ? {} : tools.displayArgs(name, args);
        if (isNew) send({ agent: { type: 'action_start', id, tool: name, args: shownArgs } });
        send({ agent: { type: 'action_update', id, patch: { status: 'running', args: shownArgs } } });

        // A body the user has not watched arrive — dumped in one frame, squeezed inside the
        // throttle window, or sent by a provider that never streams tool calls at all — is
        // replayed now. If a count is already on screen (`st.published`) it is left alone:
        // restarting it from zero would look like the file was being rewritten.
        if (
          !argError && !st.replay && !st.published && REVEAL_TOOLS.has(name) &&
          String(slot.args || '').length >= REVEAL_MIN_CHARS && isCompleteJson(slot.args)
        ) {
          st.replay = { text: slot.args, tracker: replayTracker(tools, name, slot.args) };
        }
        if (st.replay) {
          const { text, tracker } = st.replay;
          st.replay = null;
          // No writer yet (a provider that sent no deltas at all): the file starts existing now.
          if (name === 'write_file') st.writer = await writerFor(st, args.path);
          await replayBody({ text, tracker, send, id, signal, writer: name === 'write_file' ? st.writer : null });
          // Stopped while the file was still being written: do NOT run the tool. Bailing out here is
          // what lets the run's cleanup put the half-written file back the way it was.
          if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        }

        // coalesce terminal output so a chatty build doesn't flood the stream
        let outBuf = '';
        let outTimer = null;
        const flushOut = () => {
          clearTimeout(outTimer);
          outTimer = null;
          if (outBuf) {
            send({ agent: { type: 'action_update', id, patch: { outputAppend: outBuf } } });
            outBuf = '';
          }
        };
        const ctx = {
          signal,
          state,
          emit: (patch) => {
            if (patch.outputAppend) {
              outBuf += patch.outputAppend;
              if (!outTimer) outTimer = setTimeout(flushOut, OUTPUT_FLUSH_MS);
            }
          },
          approve: async (info) => {
            const key = `${runId}:${id}`;
            send({ agent: { type: 'action_update', id, patch: { status: 'awaiting_approval', approval: { key, command: info.command } } } });
            const allowed = await requestApproval(key, { signal });
            send({ agent: { type: 'action_update', id, patch: { status: allowed ? 'running' : 'denied', approval: null } } });
            return allowed;
          },
        };

        // Every line written so far is already on disk; let the last of them land, and tell the
        // tool what the file held BEFORE — otherwise it would diff against our own draft.
        let execArgs = args;
        const writer = name === 'write_file' ? await writerFor(st, args.path) : null;
        st.writer = writer || st.writer || null;
        if (writer) {
          await writer.settle();
          writer.close(); // from here the file is the tool's, not the stream's
          execArgs = { ...args, _original: writer.original, _originalExisted: writer.existed };
        }

        const t0 = Date.now();
        let res;
        // A big write_file that hits the output limit arrives as unfinished JSON. Throwing it away wastes
        // everything the model wrote: keep every complete line, and tell it to carry on with append_file.
        const rescued = argError && round.finishReason === 'length' ? tools.salvageWrite(name, slot.args) : null;
        if (rescued) {
          const salvaged = { path: rescued.path, content: rescued.content, _partial: true };
          if (writer) Object.assign(salvaged, { _original: writer.original, _originalExisted: writer.existed });
          const saved = await tools.execute(name, salvaged, ctx);
          if (saved.ok) {
            const tailLines = splitLines(rescued.content).slice(-3).join('\n');
            res = {
              ...saved,
              ui: { ...saved.ui, partial: true },
              output:
                `${saved.output}\n⚠ Your output hit the length limit in the middle of this call, so the JSON was cut off. ` +
                `I saved the ${rescued.lines} complete lines you had written to ${rescued.path} (the half-written last line was dropped). ` +
                `The file currently ends with:\n${tailLines}\n` +
                'Continue WITHOUT repeating anything: call append_file with the remaining content, starting right after that last line, and keep each call to about 150 lines or fewer.',
            };
          } else {
            res = saved;
          }
        } else if (argError) {
          res = { ok: false, output: `Error: ${argError}`, error: argError, ui: { kind: name, ok: false } };
        } else if (argsTruncated) {
          // Recovered from cut-off JSON: write what arrived, do not judge the unfinished file yet.
          const partialArgs = { ...execArgs, _partial: true };
          const saved = await tools.execute(name, partialArgs, ctx);
          if (saved.ok && (name === 'write_file' || name === 'append_file')) {
            const lines = splitLines(args.content || '').length;
            const tailLines = splitLines(args.content || '').slice(-3).join('\n');
            res = {
              ...saved,
              ui: { ...saved.ui, partial: true },
              output:
                `${saved.output}\n⚠ This call arrived cut off, so I recovered ${lines} complete lines and wrote them. ` +
                `The file currently ends with:\n${tailLines}\n` +
                'Continue WITHOUT repeating anything: call append_file with the remaining content, starting right after that last line.',
            };
          } else {
            res = saved;
          }
        } else if (!tools.has(name)) {
          const msg = `Unknown tool "${name}". Available tools: ${tools.definitions.map((d) => d.function.name).join(', ')}.`;
          res = { ok: false, output: `Error: ${msg}`, error: msg, ui: { kind: name, ok: false } };
        } else {
          res = await tools.execute(name, execArgs, ctx);
        }
        flushOut();
        // A write that landed needs no undo; one that did not must leave the file as it was.
        if (writer && res?.ok) state.committedWrites.add(writer);

        send({
          agent: {
            type: 'action_end',
            id,
            status: res.denied ? 'denied' : res.ok ? 'done' : 'error',
            ok: Boolean(res.ok),
            result: res.ui,
            output: res.uiOutput,
            error: res.ok ? undefined : String(res.error || res.output || '').slice(0, 400),
            durationMs: Date.now() - t0,
          },
        });
        return { name, modelId, rawArgs: slot.args, res };
      };

      /** In order: repeated failures get a nudge, then a stop; the model reads each result back. @returns true to stop the round */
      const settle = ({ name, modelId, rawArgs, res }) => {
        let output = truncateMiddle(String(res.output ?? ''), limits.maxOutputChars, 'output');
        let stop = false;
        if (!res.ok && !res.failedSoft && !res.denied) {
          const key = `${name}:${rawArgs}`;
          const n = (failCounts.get(key) || 0) + 1;
          failCounts.set(key, n);
          if (n >= 2) output += `\n[RECOVERY] This exact call has now failed ${n} times. Do not repeat it — read the error, change your approach, or ask the user.`;
          if (n >= 4 && !wrapUp) {
            wrapUp = 'repeated_failures';
            stop = true;
          }
        }
        messages.push({ role: 'tool', tool_call_id: modelId, content: output });
        if (stop) {
          messages.push({
            role: 'user',
            content: '[system notice] You keep repeating a call that fails. Stop calling tools. Explain to the user what you were trying to do, what failed, and what they could try.',
          });
        }
        return stop;
      };

      // Independent read-only calls (reads, searches, outlines…) run side by side; anything that changes
      // something runs on its own, in order. Results always go back to the model in the order it asked.
      const canOverlap = (p) => READ_ONLY_TOOLS.has(p.slot.name) && tools.has(p.slot.name);
      for (let i = 0; i < prepared.length; ) {
        if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        const group = [prepared[i]];
        if (canOverlap(prepared[i])) {
          while (i + group.length < prepared.length && group.length < MAX_PARALLEL && canOverlap(prepared[i + group.length])) group.push(prepared[i + group.length]);
        }
        const finished = await Promise.all(group.map(execute));
        let stopRound = false;
        for (const f of finished) stopRound = settle(f) || stopRound;
        i += group.length;
        if (stopRound) break;
      }

      // every tool_call must have an answer, even if we bailed out of the loop above
      const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      for (const { modelId } of prepared) {
        if (!answered.has(modelId)) messages.push({ role: 'tool', tool_call_id: modelId, content: 'Skipped.' });
      }
      stopReason = wrapUp || stopReason;
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) {
      stopReason = 'aborted';
    } else {
      stopReason = 'error';
      const message = err instanceof LlmError ? err.message : err?.message || 'The agent stopped unexpectedly.';
      if (!(err instanceof LlmError)) console.error('[agent] run failed:', err);
      send({ error: message });
    }
  } finally {
    // A run that stopped mid-write must not leave half a file behind: put back what was there.
    for (const w of state.liveWriters) {
      if (!state.committedWrites.has(w)) await w.rollback().catch(() => {});
    }
    cancelApprovalsFor(`${runId}:`);
    send({
      agent: {
        type: 'run_end',
        stopReason,
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        durationMs: Date.now() - startedAt,
        changed: [...state.changed].map(([path, v]) => ({ path, ...v })),
      },
    });
    send({ status: '' });
  }
  return { stopReason, ...stats };
}
