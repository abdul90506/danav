/**
 * The flight recorder: everything one agent run did, kept on disk.
 *
 * When a run goes wrong the question is never "what did it answer" — it is
 * what instructions it was given, which tools it was offered, which model
 * actually served each round after the fallback moved it, what every tool was
 * called with, what came back, and where the time and tokens went. None of
 * that survived a run: the UI keeps a summary, the journal keeps a few lines,
 * and the rest was gone the moment the stream closed.
 *
 * A trace is one JSONL file per run, under the conversation it belongs to, so
 * each chat has its own history and a server restart changes nothing. Events
 * are appended as they happen, never buffered until the end — a run that
 * crashes or is killed still leaves its trace behind, which is exactly the run
 * worth reading.
 *
 * Secrets never reach it: every string passes through the run's redactor, and
 * long bodies are clipped rather than stored whole.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDir } from './config.js';

/** One event's text payload is clipped here; a trace is evidence, not a mirror. */
const MAX_TEXT = 20_000;
/** A whole run's file. Past this the run is still recorded, just without bodies. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Runs kept per conversation. Old ones are pruned only when this is exceeded. */
const MAX_RUNS_PER_CHAT = 200;

const tracesRoot = () => {
  ensureDataDir();
  return path.join(dataDir(), 'traces');
};

/** A filesystem-safe folder name for a conversation id. */
const chatFolder = (id) => {
  const safe = String(id || 'unassigned').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || 'unassigned';
};

function clip(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[${value.length - max} more characters]`;
}

/** Clip every string inside a structure, so one huge argument cannot bloat a trace. */
function clipDeep(value, max = 4000, depth = 0) {
  if (depth > 6) return '[too deep]';
  if (typeof value === 'string') return clip(value, max);
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => clipDeep(item, max, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) out[key] = clipDeep(item, max, depth + 1);
    return out;
  }
  return value;
}

/**
 * A recorder for one run.
 *
 * Every method is best-effort: tracing must never be able to fail a run, so a
 * full disk or a missing directory costs the trace and nothing else.
 */
export function startTrace({ runId, chatId, meta = {}, redact = (text) => text } = {}) {
  const startedAt = Date.now();
  let file = '';
  let bytes = 0;
  let closed = false;
  let seq = 0;

  try {
    const dir = path.join(tracesRoot(), chatFolder(chatId));
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${String(runId || 'run').replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  } catch {
    file = '';
  }

  const write = (type, data) => {
    if (!file || closed) return;
    try {
      const line = `${JSON.stringify({ seq: seq++, at: Date.now(), ms: Date.now() - startedAt, type, ...data })}\n`;
      // Past the cap the structure of the run is still recorded; the bodies stop.
      if (bytes + line.length > MAX_FILE_BYTES) {
        if (bytes < MAX_FILE_BYTES) {
          const notice = `${JSON.stringify({ seq: seq++, at: Date.now(), type: 'trace_truncated', note: 'This run exceeded the per-run trace size; later event bodies were dropped.' })}\n`;
          fs.appendFileSync(file, notice);
          bytes = MAX_FILE_BYTES;
        }
        return;
      }
      fs.appendFileSync(file, line);
      bytes += line.length;
    } catch {
      /* A trace that cannot be written must not take the run down with it. */
    }
  };

  const safe = (value) => {
    try {
      return clipDeep(JSON.parse(JSON.stringify(value ?? null)));
    } catch {
      return String(value ?? '');
    }
  };
  const scrub = (value) => {
    if (typeof value === 'string') return redact(value);
    try {
      return JSON.parse(redact(JSON.stringify(value ?? null)));
    } catch {
      return safe(value);
    }
  };

  write('run_start', { runId, chatId, meta: safe(scrub(meta)) });
  pruneChat(chatId);

  return {
    file,
    /** The complete system prompt, tool list and budgets this run was given. */
    instructions({ systemPrompt, tools, limits, model, provider, thinkingLevel, history }) {
      write('instructions', {
        model,
        provider: safe(scrub(provider)),
        thinkingLevel,
        limits: safe(limits),
        systemPrompt: clip(redact(String(systemPrompt || ''))),
        systemPromptChars: String(systemPrompt || '').length,
        tools: Array.isArray(tools) ? tools.map((t) => t?.function?.name || t?.name).filter(Boolean) : [],
        historyTurns: Array.isArray(history) ? history.length : 0,
      });
    },
    /** One request to the provider, as it was actually sent. */
    request({ round, model, messages, newMessages, chars }) {
      write('request', {
        round,
        model,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        chars,
        // Only what this round added: the full transcript is the sum of these.
        added: safe(scrub(newMessages || [])),
      });
    },
    /** What the model said, and what it asked to run. */
    response({ round, model, text, toolCalls, usage, finishReason }) {
      write('response', {
        round,
        model,
        text: clip(redact(String(text || ''))),
        toolCalls: safe(scrub(toolCalls || [])),
        usage: safe(usage),
        finishReason,
      });
    },
    /** One tool call, with its arguments, its result and how long it took. */
    tool({ round, name, args, ok, output, error, durationMs, denied }) {
      write('tool', {
        round,
        name,
        args: safe(scrub(args)),
        ok: ok !== false && !error,
        denied: denied || false,
        durationMs,
        output: clip(redact(String(output ?? ''))),
        error: error ? clip(redact(String(error)), 2000) : undefined,
      });
    },
    /** A routing decision: a model swap, a key rotation, a quota park, a retry. */
    routing(data) {
      write('routing', safe(scrub(data)));
    },
    /** Anything the run wants on the record: a notice, a nudge, a prune, a stall. */
    note(kind, data = {}) {
      write('note', { kind, ...safe(scrub(data)) });
    },
    /** An error that reached the run. */
    failure(data) {
      write('error', safe(scrub(data)));
    },
    finish(summary = {}) {
      if (closed) return;
      write('run_end', { durationMs: Date.now() - startedAt, ...safe(scrub(summary)) });
      closed = true;
    },
  };
}

/** A recorder that writes nothing, for code paths with no trace configured. */
export const nullTrace = {
  file: '',
  instructions() {},
  request() {},
  response() {},
  tool() {},
  routing() {},
  note() {},
  failure() {},
  finish() {},
};

/** Oldest runs go only when a chat has more than the cap. Nothing else deletes. */
function pruneChat(chatId) {
  try {
    const dir = path.join(tracesRoot(), chatFolder(chatId));
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    if (files.length <= MAX_RUNS_PER_CHAT) return;
    const withTime = files.map((name) => ({
      name,
      at: fs.statSync(path.join(dir, name)).mtimeMs,
    })).sort((a, b) => a.at - b.at);
    for (const item of withTime.slice(0, files.length - MAX_RUNS_PER_CHAT)) {
      fs.rmSync(path.join(dir, item.name), { force: true });
    }
  } catch {
    /* Pruning is housekeeping; failing it changes nothing about this run. */
  }
}

// ---------------------------------------------------------------------------
// Reading traces back
// ---------------------------------------------------------------------------

/** Every chat that has traces, newest activity first. */
export function listTracedChats() {
  try {
    return fs.readdirSync(tracesRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(tracesRoot(), entry.name);
        const runs = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
        let latest = 0;
        let bytes = 0;
        for (const name of runs) {
          const st = fs.statSync(path.join(dir, name));
          latest = Math.max(latest, st.mtimeMs);
          bytes += st.size;
        }
        return { chatId: entry.name, runs: runs.length, updatedAt: latest, bytes };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

const readEvents = (file) => {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a half-written last line is normal */ }
  }
  return out;
};

/** The runs of one chat, each with the headline facts, newest first. */
export function listRuns(chatId) {
  try {
    const dir = path.join(tracesRoot(), chatFolder(chatId));
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        const events = readEvents(file);
        const start = events.find((e) => e.type === 'run_start');
        const instructions = events.find((e) => e.type === 'instructions');
        const end = events.find((e) => e.type === 'run_end');
        const tools = events.filter((e) => e.type === 'tool');
        const requests = events.filter((e) => e.type === 'request');
        const routings = events.filter((e) => e.type === 'routing');
        const errors = events.filter((e) => e.type === 'error' || (e.type === 'tool' && e.ok === false));
        const models = [...new Set(requests.map((r) => r.model).filter(Boolean))];
        return {
          runId: name.replace(/\.jsonl$/, ''),
          startedAt: start?.at || st.mtimeMs,
          durationMs: end?.durationMs ?? null,
          stopReason: end?.stopReason || (end ? 'completed' : 'incomplete'),
          request: start?.meta?.request || '',
          model: instructions?.model || models[0] || '',
          modelsUsed: models,
          switched: Math.max(0, models.length - 1),
          rounds: requests.length,
          toolCalls: tools.length,
          failures: errors.length,
          routingEvents: routings.length,
          usage: end?.usage || null,
          changed: end?.changed || [],
          bytes: st.size,
          events: events.length,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

/** One run in full, exactly as it was recorded. */
export function readRun(chatId, runId) {
  try {
    const file = path.join(
      tracesRoot(),
      chatFolder(chatId),
      `${String(runId).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`
    );
    return { runId, events: readEvents(file) };
  } catch {
    return null;
  }
}

/** Every run of a chat, with its full events, for analysis. */
export function readAllRuns(chatId, max = 40) {
  try {
    const dir = path.join(tracesRoot(), chatFolder(chatId));
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map(({ name }) => ({
        runId: name.replace(/\.jsonl$/, ''),
        events: readEvents(path.join(dir, name)),
      }));
  } catch {
    return [];
  }
}

/** Remove every trace of one chat. The only deletion a user can ask for. */
export function deleteChatTraces(chatId) {
  try {
    fs.rmSync(path.join(tracesRoot(), chatFolder(chatId)), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
