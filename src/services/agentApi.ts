import type {
  AgentConfig,
  AgentWorkspace,
  ChatMessageContent,
  Provider,
  SandboxState,
  SandboxStatus,
  SandboxSummary,
  SandboxTotals,
  ThinkingLevel,
} from '../types';
import { previewAuthHeaders } from './previewAuth.ts';

/**
 * Client for the Agent mode API. Every request carries `x-danav-agent: 1`:
 * the server refuses these routes without it, which is what stops other web
 * pages from driving them (browsers can't add that header cross-origin).
 */
const agentHeaders = () => ({ 'Content-Type': 'application/json', 'x-danav-agent': '1', ...previewAuthHeaders() });

export class AgentApiError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AgentApiError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/agent${url}`, {
      method,
      headers: agentHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AgentApiError('Could not reach the Danav server. Is it running?');
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok || json?.success === false) {
    throw new AgentApiError(json?.error || `Request failed (HTTP ${res.status})`, {
      code: json?.code,
      status: res.status,
    });
  }
  return json as T;
}

export const getAgentConfig = () => call<{ success: true } & AgentConfig>('GET', '/config');

export async function listWorkspaces(): Promise<AgentWorkspace[]> {
  return (await call<{ workspaces: AgentWorkspace[] }>('GET', '/workspaces')).workspaces;
}

export async function createWorkspace(opts: {
  name?: string;
  kind: 'sandbox' | 'local';
  path?: string;
  autoRun?: boolean;
}): Promise<AgentWorkspace> {
  return (await call<{ workspace: AgentWorkspace }>('POST', '/workspaces', opts)).workspace;
}

export async function updateWorkspace(
  id: string,
  patch: { autoRun?: boolean; autoPause?: boolean; name?: string }
): Promise<AgentWorkspace> {
  return (await call<{ workspace: AgentWorkspace }>('PATCH', `/workspaces/${encodeURIComponent(id)}`, patch)).workspace;
}

/** Stop an active agent stream and wait until the server releases its workspace lock. */
export const stopAgentRun = (workspaceId: string) =>
  call<{ success: true; active: false }>('POST', `/workspaces/${encodeURIComponent(workspaceId)}/stop`, {});

export const deleteWorkspace = (id: string) => call('DELETE', `/workspaces/${encodeURIComponent(id)}`);

// ---------------------------------------------------------------------------
// Sandboxes (account-wide)
// ---------------------------------------------------------------------------
// The agent only knows the sandboxes it created, one per workspace. These calls
// see the WHOLE Novita account, so leftovers from old sessions can be paused or
// deleted instead of quietly burning CPU.

export async function listSandboxes(state?: 'running' | 'paused') {
  return call<{ configured: boolean; sandboxes: SandboxSummary[]; totals: SandboxTotals }>(
    'GET',
    `/sandboxes${state ? `?state=${state}` : ''}`
  );
}

export const pauseSandbox = (sandboxId: string) =>
  call<{ sandboxId: string; state: SandboxState; changed: boolean }>(
    'POST',
    `/sandboxes/${encodeURIComponent(sandboxId)}/pause`
  );

export const resumeSandbox = (sandboxId: string) =>
  call<{ sandboxId: string; state: SandboxState; changed: boolean }>(
    'POST',
    `/sandboxes/${encodeURIComponent(sandboxId)}/resume`
  );

export const killSandbox = (sandboxId: string) =>
  call<{ sandboxId: string; state: SandboxState; changed: boolean; detachedWorkspaceId: string | null }>(
    'DELETE',
    `/sandboxes/${encodeURIComponent(sandboxId)}`
  );

export const getSandboxStatus = (workspaceId: string) =>
  call<{ configured: boolean; status: SandboxStatus }>(
    'GET',
    `/sandboxes/status?workspaceId=${encodeURIComponent(workspaceId)}`
  );

/** Wake a workspace's sandbox and reset its idle clock (used before a preview). */
export const wakeWorkspace = (workspaceId: string) =>
  call<{ sandboxId: string | null }>('POST', `/workspaces/${encodeURIComponent(workspaceId)}/wake`);

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link';
  size?: number;
}

export const getTree = (id: string, path = '.') =>
  call<{ path: string; truncated: boolean; entries: TreeEntry[] }>(
    'GET',
    `/workspaces/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(path)}`
  );

/**
 * Every file in the workspace, flat, for the composer's @-mention picker.
 * Ranking happens in the browser as the user types, so this is fetched once per
 * workspace rather than per keystroke.
 */
export const listWorkspaceFiles = (id: string, limit = 2000) =>
  call<{ files: string[]; truncated: boolean }>(
    'GET',
    `/workspaces/${encodeURIComponent(id)}/files?limit=${limit}`
  );

export const getFile = (id: string, path: string) =>
  call<{ path: string; size: number; binary: boolean; truncated: boolean; text: string }>(
    'GET',
    `/workspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`
  );

/** One entry of the composer's skill picker — the same list `load_skill` accepts. */
export interface AgentSkill {
  key: string;
  name: string;
  description: string;
  path?: string;
  source?: string;
}

export const listSkills = (workspaceId: string) =>
  call<{ skills: AgentSkill[] }>('GET', `/workspaces/${encodeURIComponent(workspaceId)}/skills`);

/** One recorded run, as the Run Log lists it. */
export interface TraceRunSummary {
  runId: string;
  startedAt: number;
  durationMs: number | null;
  stopReason: string;
  request: string;
  model: string;
  modelsUsed: string[];
  switched: number;
  rounds: number;
  toolCalls: number;
  failures: number;
  routingEvents: number;
  usage: { inputTokens?: number; outputTokens?: number; rounds?: number } | null;
  changed: Array<{ path: string; added?: number; removed?: number }>;
  bytes: number;
  events: number;
  /** No run_end on disk: happening now, or killed before it could finish. */
  live?: boolean;
}

/** A chat that has traces, as the inspector's chat picker lists it. */
export interface TraceChatSummary {
  chatId: string;
  runs: number;
  updatedAt: number;
  bytes: number;
  label: string;
}

/** One line of a trace. `type` says which shape the rest of it has. */
export interface TraceEvent {
  seq: number;
  at: number;
  ms: number;
  type: string;
  [key: string]: unknown;
}

export const listTraceChats = () => call<{ chats: TraceChatSummary[] }>('GET', '/traces');

export const listTraceRuns = (chatId: string) =>
  call<{ runs: TraceRunSummary[] }>('GET', `/traces?chatId=${encodeURIComponent(chatId)}`);

/**
 * One run's events. `since` asks for only what was written after that sequence
 * number, which is how a run still in flight is followed without pulling its
 * whole body down every poll.
 */
export const getTraceRun = (chatId: string, runId: string, since?: number) =>
  call<{ events: TraceEvent[]; total: number; live: boolean }>(
    'GET',
    `/traces/${encodeURIComponent(chatId)}/${encodeURIComponent(runId)}${
      typeof since === 'number' && since >= 0 ? `?since=${since}` : ''
    }`
  );

/** One fault the recorder found, with the evidence that proves it. */
export interface TraceFinding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  count: number;
  hint: string;
  runId?: string;
  runs?: string[];
  occurrences?: number;
  seqs?: number[];
}

export const getTraceAnalysis = (chatId: string) =>
  call<{ findings: TraceFinding[]; runsAnalysed: number }>(
    'GET',
    `/traces/${encodeURIComponent(chatId)}/analysis`
  );

export const clearTraces = (chatId: string) =>
  call<{ success: boolean }>('DELETE', `/traces/${encodeURIComponent(chatId)}`);

export interface MemoryNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  category?: 'preference' | 'project' | 'decision' | 'workflow' | 'gotcha' | 'other';
  importance?: number;
  tags?: string[];
}

export interface MemoryRun {
  id: string;
  at: number;
  stopReason: string;
  changed: Array<{ path: string; added: number; removed: number }>;
  checks: Array<{ name: string; passed: boolean; exitCode?: number; timedOut?: boolean; aborted?: boolean }>;
  failures: number;
}

/**
 * One task-step summary, as the agent wrote it during a run — the thing that
 * is handed back to the model when the same task continues.
 */
export interface MemoryStep {
  id: string;
  at: number;
  runId: string;
  taskKey: string;
  summary: string;
  steps: string[];
  facts: string[];
  decisions: string[];
  errors: string[];
  next: string;
  source: 'local' | 'model' | string;
  /** Each file the entry mentions, and whether it still exists. */
  files: Array<{ path: string; missing: boolean }>;
}

export const getMemory = (workspaceId: string, taskKey?: string) =>
  call<{
    notes: MemoryNote[];
    runs?: MemoryRun[];
    /** What this chat is told when it continues, verbatim. */
    block?: string;
    blockChars?: number;
    /** The project's living summary — one document, every chat gets it. */
    projectBlock?: string;
    project?: {
      overview: string;
      done: string[];
      decisions: string[];
      gotchas: string[];
      open: string;
      runs: number;
      updatedAt: number;
    };
    steps?: MemoryStep[];
  }>(
    'GET',
    `/workspaces/${encodeURIComponent(workspaceId)}/memory${
      taskKey ? `?taskKey=${encodeURIComponent(taskKey)}` : ''
    }`
  );

export const deleteMemoryNote = (workspaceId: string, noteId: string) =>
  call<{ notes: MemoryNote[] }>('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(noteId)}`);

export const clearMemory = (workspaceId: string) =>
  call<{ notes: MemoryNote[] }>('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}/memory`);

export const saveNovitaKey = (apiKey: string) =>
  call<{ configured: boolean; source: 'env' | 'saved' | null }>('POST', '/novita/key', { apiKey });

export const clearNovitaKey = () => call('DELETE', '/novita/key');

export const answerApproval = (
  key: string,
  opts: { allow: boolean; always?: boolean; workspaceId?: string }
) => call('POST', `/approvals/${encodeURIComponent(key)}`, opts);

// ---------------------------------------------------------------------------
// The run itself (Server-Sent Events)
// ---------------------------------------------------------------------------

export interface AgentStreamOptions {
  provider: Provider;
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ChatMessageContent }>;
  workspaceId: string;
  /** Stable id for this task; reused only when the stopped assistant turn is continued. */
  taskId?: string;
  /** One-line summaries of what the agent did earlier in this conversation. */
  activity?: string[];
  /** This request continues a run that stopped early. */
  resume?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
  onContent: (text: string) => void;
  onThinking: (text: string) => void;
  onAgent: (event: any) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Deliberately NO automatic retry: replaying an agent run would repeat its side
 * effects (files written, commands run). A dropped connection is reported, and
 * the user decides whether to continue.
 */
export async function streamAgentRun(o: AgentStreamOptions): Promise<void> {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    o.onDone();
  };

  try {
    const response = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: agentHeaders(),
      signal: o.signal,
      body: JSON.stringify({
        provider: {
          id: o.provider.id,
          baseUrl: o.provider.baseUrl,
          apiKey: o.provider.apiKey,
          apiType: o.provider.apiType,
        },
        model: o.model,
        thinkingLevel: o.thinkingLevel,
        messages: o.messages,
        workspaceId: o.workspaceId,
        taskId: o.taskId,
        activity: o.activity,
        resume: o.resume === true,
      }),
    });

    if (!response.ok) {
      let message = `Server error (HTTP ${response.status})`;
      try {
        const json = await response.json();
        if (json?.error) message = json.error;
      } catch {
        /* keep the generic message */
      }
      o.onError(message);
      return done();
    }
    if (!response.body) {
      o.onError('The server sent no data.');
      return done();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawDone = false;

    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }
        let ev: any;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue; // partial chunk
        }
        if (typeof ev.status === 'string') o.onStatus?.(ev.status);
        if (ev.content) o.onContent(ev.content);
        if (ev.thinking) o.onThinking(ev.thinking);
        if (ev.agent) o.onAgent(ev.agent);
        if (ev.error) o.onError(String(ev.error));
      }
    }
    if (!sawDone && !o.signal?.aborted) {
      o.onError('The connection to the server was lost. Your files are safe — say "continue" to pick up where it stopped.');
    }
    done();
  } catch (err: any) {
    if (err?.name === 'AbortError' || o.signal?.aborted) return done();
    o.onError(err?.message || 'The connection was interrupted.');
    done();
  }
}
