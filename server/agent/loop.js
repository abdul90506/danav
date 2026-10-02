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
  const state = { readFiles: new Set(), plan: [], changed: new Map(), singleEdits: new Map() };
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

      const onDelta = (slot) => {
        if (!useTools || !slot.name) return;
        const now = Date.now();
        let st = live.get(slot);
        if (!st) {
          st = { uiId: genId('a'), lastSent: now, lastKey: '', tracker: tools.progressTracker(slot.name) };
          live.set(slot, st);
          const { args, progress } = st.tracker.update(slot.args);
          send({ agent: { type: 'action_start', id: st.uiId, tool: slot.name, args, ...(progress ? { progress } : {}) } });
          return;
        }
        if (now - st.lastSent < PROGRESS_THROTTLE_MS) return;
        const { args, progress } = st.tracker.update(slot.args);
        const key = JSON.stringify([args, progress && [progress.added, progress.removed, progress.tail]]);
        if (key === st.lastKey) return;
        st.lastKey = key;
        st.lastSent = now;
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
        const st = live.get(slot) || { uiId: genId('a'), lastSent: 0, lastKey: '', tracker: tools.progressTracker(slot.name) };
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
        const { progress } = p.st.tracker.update(p.slot.args);
        const patch = { ...(progress ? { progress } : {}), ...(i > 0 ? { status: 'queued' } : {}) };
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
        try {
          args = slot.args.trim() ? JSON.parse(slot.args) : {};
          if (!args || typeof args !== 'object' || Array.isArray(args)) argError = 'Arguments must be a JSON object.';
        } catch (err) {
          argError =
            round.finishReason === 'length'
              ? 'Your tool call was cut off because the output limit was reached, so its JSON is incomplete. Send a smaller call — for big files, write them in several smaller files.'
              : `The arguments are not valid JSON (${err.message}). Send a single valid JSON object.`;
        }

        const shownArgs = argError ? {} : tools.displayArgs(name, args);
        if (isNew) send({ agent: { type: 'action_start', id, tool: name, args: shownArgs } });
        send({ agent: { type: 'action_update', id, patch: { status: 'running', args: shownArgs } } });

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

        const t0 = Date.now();
        let res;
        // A big write_file that hits the output limit arrives as unfinished JSON. Throwing it away wastes
        // everything the model wrote: keep every complete line, and tell it to carry on with append_file.
        const rescued = argError && round.finishReason === 'length' ? tools.salvageWrite(name, slot.args) : null;
        if (rescued) {
          const saved = await tools.execute(name, { path: rescued.path, content: rescued.content, _partial: true }, ctx);
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
        } else if (!tools.has(name)) {
          const msg = `Unknown tool "${name}". Available tools: ${tools.definitions.map((d) => d.function.name).join(', ')}.`;
          res = { ok: false, output: `Error: ${msg}`, error: msg, ui: { kind: name, ok: false } };
        } else {
          res = await tools.execute(name, args, ctx);
        }
        flushOut();

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
