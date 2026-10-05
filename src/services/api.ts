import type {
  AgentSummaryModelSelection,
  ChatMessageContent,
  ChatRequestPayload,
  Conversation,
  Model,
  Provider,
  ThinkingLevel,
  ToolExecution,
} from '../types';
import { sanitizeConversations, stripImagePayloads } from './storage.ts';
import { previewAuthHeaders } from './previewAuth.ts';

export interface TestProviderResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface FetchModelsResponse {
  success: boolean;
  models?: Model[];
  error?: string;
}

export async function testProviderConnection(
  provider: Pick<Provider, 'baseUrl' | 'apiKey' | 'apiKeys' | 'apiType' | 'clearApiKeys'> & { id?: string }
): Promise<TestProviderResponse> {
  try {
    const res = await fetch('/api/providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
      body: JSON.stringify(provider),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Connection failed with status ${res.status}`,
      };
    }
    return {
      success: true,
      message: data.message || 'Connection verified successfully',
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error: could not connect to server',
    };
  }
}

export async function fetchProviderModels(
  provider: Pick<Provider, 'id' | 'baseUrl' | 'apiKey' | 'apiKeys' | 'apiType' | 'clearApiKeys'>
): Promise<FetchModelsResponse> {
  try {
    const res = await fetch('/api/providers/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
      body: JSON.stringify(provider),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Failed to fetch models (HTTP ${res.status})`,
      };
    }

    const models: Model[] = (data.models || []).map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      providerId: provider.id,
      supportsThinking: Boolean(m.supportsThinking),
      description: m.description,
    }));

    return {
      success: true,
      models,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error fetching models',
    };
  }
}

export interface StreamChatOptions {
  provider: Provider;
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ChatMessageContent }>;
  /** Offer the web tools to the model so it can research on its own. */
  toolsEnabled?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
  onChunk: (chunk: string) => void;
  onThinking?: (thinking: string) => void;
  /**
   * A web tool the model chose to run. Fired once when it starts (`running`)
   * and again when it settles (`done`), so the UI can show the same research
   * trail agent mode used to show.
   */
  onTool?: (tool: ToolExecution) => void;
  /** Provider stop reason, e.g. "stop" or "length" (cut off by the token limit). */
  onFinishReason?: (reason: string) => void;
  onError: (errorMsg: string) => void;
  onDone: () => void;
}

export async function streamChatCompletion({
  provider,
  model,
  thinkingLevel,
  messages,
  toolsEnabled,
  signal,
  onStatus,
  onChunk,
  onThinking,
  onTool,
  onFinishReason,
  onError,
  onDone,
}: StreamChatOptions): Promise<void> {
  const maxRetries = 3;
  let attempt = 0;
  /**
   * Whether any content has already reached the caller.
   *
   * A retry replays the request from the beginning, so once text has been
   * delivered a retry would append a second copy of the reply on top of the
   * first. Only a failure BEFORE the first token (a refused connection, a
   * startup 5xx) is safe to retry here; anything later is handed to the caller,
   * which owns resetting its own buffer before trying again.
   */
  let delivered = false;

  while (attempt <= maxRetries) {
    if (signal?.aborted) {
      onDone();
      return;
    }

    try {
      const payload: ChatRequestPayload = {
        provider: {
          id: provider.id,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiType: provider.apiType,
        },
        model,
        thinkingLevel,
        messages,
        ...(toolsEnabled ? { toolsEnabled: true } : {}),
      };

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...previewAuthHeaders(),
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        let errorMsg = `Server error (HTTP ${response.status})`;
        try {
          const errJson = await response.json();
          if (errJson.error) errorMsg = errJson.error;
        } catch {
          const text = await response.text();
          if (text) errorMsg = text.slice(0, 150);
        }

        // Retry on 5xx or 429
        if ((response.status >= 500 || response.status === 429) && attempt < maxRetries) {
          throw new Error(errorMsg);
        }

        onError(errorMsg);
        onDone();
        return;
      }

      if (!response.body) {
        throw new Error('No response body received from provider.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed === 'data: [DONE]') {
            onDone();
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const raw = trimmed.slice(6);
            try {
              const parsed = JSON.parse(raw);
              if (parsed.status && onStatus) {
                onStatus(parsed.status);
              }
              if (parsed.content) {
                delivered = true;
                onChunk(parsed.content);
              }
              if (parsed.thinking && onThinking) {
                delivered = true;
                onThinking(parsed.thinking);
              }
              if (parsed.tool && onTool) {
                onTool(parsed.tool as ToolExecution);
              }
              if (parsed.finishReason && onFinishReason) {
                onFinishReason(String(parsed.finishReason));
              }
              if (parsed.error) {
                // An error event means the provider gave up mid-stream. Report
                // it and STOP consuming: continuing to read left the caller's
                // abort controller cleared (so Stop could no longer abort) while
                // chunks kept arriving.
                onError(parsed.error);
                try {
                  await reader.cancel();
                } catch {
                  /* already closed */
                }
                return;
              }
              if (parsed.done) {
                onDone();
                return;
              }
            } catch (e) {
              // Ignore partial SSE chunk parsing
            }
          }
        }
      }

      onDone();
      return;
    } catch (err: any) {
      if (err.name === 'AbortError' || signal?.aborted) {
        onDone();
        return;
      }

      attempt++;
      if (attempt <= maxRetries && !delivered) {
        const delaySeconds = attempt * 2;
        for (let s = delaySeconds; s > 0; s--) {
          if (signal?.aborted) {
            onDone();
            return;
          }
          onStatus?.(`Connection interrupted. Reconnecting in ${s}s (Attempt ${attempt}/${maxRetries})...`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        onStatus?.('Reconnecting to AI model...');
        continue;
      }

      onError(err.message || 'Stream interrupted unexpectedly');
      onDone();
      return;
    }
  }
}

export async function fetchBackendSettings(): Promise<{
  providers?: Provider[];
  theme?: any;
  lastSelectedProviderId?: string;
  lastSelectedModelId?: string;
  agentSummaryModel?: AgentSummaryModelSelection | null;
} | null> {
  try {
    const res = await fetch('/api/settings', { headers: previewAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      return data.settings || null;
    }
  } catch (err) {
    console.error('Failed to load settings from backend', err);
  }
  return null;
}

export async function saveBackendSettings(settings: {
  providers?: Provider[];
  theme?: string;
  lastSelectedProviderId?: string;
  lastSelectedModelId?: string;
  agentSummaryModel?: AgentSummaryModelSelection | null;
}): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
      body: JSON.stringify(settings),
    });
    return res.ok;
  } catch (err) {
    console.error('Failed to save settings to backend', err);
    return false;
  }
}

/**
 * A title the sidebar can actually show.
 *
 * The model is asked for 2-4 words, and mostly complies — but a fallback title,
 * a chatty model or a mangled response must never arrive as a paragraph, and
 * never with newlines in it. Anything unusable returns '' so the locally
 * generated title is kept.
 */
export function sanitizeChatTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const title = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!title) return '';
  return title.length > 60 ? `${title.slice(0, 60).trim()}…` : title;
}

export async function generateAIChatTitle({
  provider,
  model,
  message,
}: {
  provider: Provider;
  model: string;
  message: string;
}): Promise<string> {
  try {
    const res = await fetch('/api/chat/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
      body: JSON.stringify({
        provider: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiType: provider.apiType,
        },
        model,
        message,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const title = sanitizeChatTitle(data.title);
      if (title) return title;
    }
  } catch (err) {
    console.error('Failed calling /api/chat/title:', err);
  }
  return '';
}

export interface BackendConversationsData {
  conversations: Conversation[];
  activeChatId: string | null;
}

export async function fetchBackendConversations(): Promise<BackendConversationsData | null> {
  try {
    const res = await fetch('/api/conversations', { headers: previewAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.conversations)) {
        return {
          conversations: sanitizeConversations(data.conversations),
          activeChatId: data.activeChatId || null,
        };
      }
    }
  } catch (err) {
    console.warn('Could not fetch conversations from backend:', err);
  }
  return null;
}

export interface BackupInfo {
  success: boolean;
  conversations?: Conversation[];
  activeChatId?: string | null;
  error?: string;
}

/**
 * The copy the server keeps before it lets the chat store shrink (see
 * writeConversationsToDisk). It is the undo button for an accidental wipe.
 */
export async function fetchConversationsBackup(): Promise<BackupInfo> {
  try {
    const res = await fetch('/api/conversations/backup', { headers: previewAuthHeaders() });
    const data = await res.json();
    if (!res.ok || !data.success) {
      // 404 is the normal "nothing has gone wrong yet" case, not a failure: the
      // copy is only made the first time the store is about to shrink.
      if (res.status === 404) {
        return {
          success: false,
          error: 'No backup yet — one is kept automatically the first time a save would shrink your history.',
        };
      }
      return { success: false, error: data.error || `No backup available (HTTP ${res.status})` };
    }
    return {
      success: true,
      conversations: sanitizeConversations(data.conversations || []),
      activeChatId: data.activeChatId || null,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Could not read the backup' };
  }
}

export async function restoreConversationsBackup(): Promise<{ success: boolean; restored?: number; error?: string }> {
  try {
    const res = await fetch('/api/conversations/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Restore failed (HTTP ${res.status})` };
    }
    return { success: true, restored: data.restored };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Restore failed' };
  }
}

export interface BackendSaveResult {
  /** The server's copy of the chats is up to date. */
  ok: boolean;
  /** It only fit without the image payloads of older conversations. */
  degraded?: boolean;
}

export async function saveBackendConversations(
  conversations: Conversation[],
  activeChatId?: string | null
): Promise<BackendSaveResult> {
  const post = async (list: Conversation[]) => {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...previewAuthHeaders() },
      body: JSON.stringify({ conversations: sanitizeConversations(list), activeChatId }),
    });
    return res.ok;
  };

  try {
    if (await post(conversations)) return { ok: true };
  } catch (err) {
    console.warn('Could not save conversations to backend:', err);
    return { ok: false };
  }

  // A store that has grown too large to post is not a reason to stop syncing:
  // the conversation the user is in keeps its images, the older ones give up
  // theirs (exactly what the localStorage fallback does under quota pressure),
  // and the caller can say that the server copy is lighter than the local one.
  try {
    const activeId = activeChatId || '';
    const stripped = stripImagePayloads(conversations, new Set(activeId ? [activeId] : []));
    if (await post(stripped)) return { ok: true, degraded: true };
  } catch (err) {
    console.warn('Could not save the lighter conversations payload either:', err);
  }
  return { ok: false };
}
