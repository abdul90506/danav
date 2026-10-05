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

export const getFile = (id: string, path: string) =>
  call<{ path: string; size: number; binary: boolean; truncated: boolean; text: string }>(
    'GET',
    `/workspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`
  );

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

export const getMemory = (workspaceId: string) =>
  call<{ notes: MemoryNote[]; runs?: MemoryRun[] }>('GET', `/workspaces/${encodeURIComponent(workspaceId)}/memory`);

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
