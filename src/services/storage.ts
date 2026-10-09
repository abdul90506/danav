import type { AgentAction, Conversation, MessageBlock, Provider, Theme } from '../types';

const STORAGE_KEYS = {
  CONVERSATIONS: 'blackdesi_chat_history_v2',
  PROVIDERS: 'blackdesi_chat_providers_v2',
  THEME: 'blackdesi_chat_theme_v2',
  ACTIVE_CHAT: 'blackdesi_active_chat_id_v2',
  PREVIEW_WIDTH: 'blackdesi_preview_width_v1',
};

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'provider-vyce',
    name: 'Vyce AI',
    baseUrl: 'https://vyceai.com/v1',
    apiKey: '',
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
];

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch (e) {
    console.error('Failed reading theme from localStorage', e);
  }
  return 'light'; // Default theme is Light
}

export function saveStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  } catch (e) {
    console.error('Failed saving theme to localStorage', e);
  }
}

/**
 * How wide the docked preview was last time, in px. Remembered so the split the
 * user dragged into place survives a reload. Returns null when there is nothing
 * sensible stored (the caller then picks a default from the viewport).
 */
export function getStoredPreviewWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEYS.PREVIEW_WIDTH));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function saveStoredPreviewWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PREVIEW_WIDTH, String(Math.round(width)));
  } catch (e) {
    console.error('Failed saving the preview width to localStorage', e);
  }
}

export function sanitizeProvidersForClient(providers: Provider[]): Provider[] {
  return (Array.isArray(providers) ? providers : [])
    .filter((provider): provider is Provider => Boolean(provider && typeof provider === 'object'))
    .map((provider) => {
      const { apiKey, apiKeys, apiKeyAdditions, clearApiKey, clearApiKeys, ...safeProvider } = provider;
      const reportedCount = Number.isFinite(provider.apiKeyCount)
        ? Math.max(0, Math.floor(provider.apiKeyCount || 0))
        : 0;
      const storedCount = Math.max(
        reportedCount,
        Number(Boolean(provider.apiKeyConfigured || (typeof apiKey === 'string' && apiKey.trim()))),
        Array.isArray(apiKeys)
          ? new Set(apiKeys.flatMap((key) => typeof key === 'string' && key.trim() ? [key.trim()] : [])).size
          : 0,
      );
      const additions = Array.isArray(apiKeyAdditions)
        ? [...new Set(apiKeyAdditions.filter((key) => typeof key === 'string').map((key) => key.trim()).filter(Boolean))]
        : [];
      const apiKeyCount = clearApiKeys || clearApiKey ? additions.length : storedCount + additions.length;
      return {
        ...safeProvider,
        apiKeyCount,
        apiKeyConfigured: apiKeyCount > 0,
      };
    });
}

export function getStoredProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROVIDERS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // If old mock provider was cached, migrate to Vyce AI
        if (parsed.some((p) => p.apiType === 'mock')) {
          saveStoredProviders(DEFAULT_PROVIDERS);
          return sanitizeProvidersForClient(DEFAULT_PROVIDERS);
        }
        // Remove legacy clear-text keys from localStorage immediately, but keep
        // the already-loaded key in memory for one backend migration attempt.
        // A successful settings read/save replaces this with a key-free server view.
        const safe = sanitizeProvidersForClient(parsed);
        saveStoredProviders(safe);
        return safe.map((provider) => {
          const legacy = parsed.find((candidate: Provider) => candidate?.id === provider.id);
          const copy = { ...provider };
          // Only the old single-key field is kept in memory for the existing
          // one-time backend migration. Multi-key values and all edit intents
          // are stripped before this provider state reaches React.
          if (typeof legacy?.apiKey === 'string' && legacy.apiKey.trim()) {
            copy.apiKey = legacy.apiKey;
            copy.apiKeyConfigured = true;
          }
          return copy;
        });
      }
    }
  } catch (e) {
    console.error('Failed reading providers from localStorage', e);
  }
  return sanitizeProvidersForClient(DEFAULT_PROVIDERS);
}

export function saveStoredProviders(providers: Provider[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PROVIDERS, JSON.stringify(sanitizeProvidersForClient(providers)));
  } catch (e) {
    console.error('Failed saving providers to localStorage', e);
  }
}

const LIVE_ACTION = new Set(['pending', 'queued', 'running', 'awaiting_approval']);

/**
 * An agent action as it is kept between sessions: one that never finished is
 * settled as interrupted (it must not come back shimmering), and terminal
 * output is bounded so a long build can't fill localStorage.
 */
function settleAction(a: AgentAction): AgentAction {
  const next: AgentAction = { ...a };
  if (LIVE_ACTION.has(a.status)) {
    next.status = 'error';
    next.error = 'Interrupted';
    next.approval = null;
    delete next.progress;
  }
  if (typeof next.output === 'string' && next.output.length > 4000) next.output = next.output.slice(-4000);
  return next;
}

export function sanitizeConversations(conversations: Conversation[]): Conversation[] {
  if (!Array.isArray(conversations)) return [];
  return conversations.map((conv) => ({
    ...conv,
    messages: (conv.messages || []).map((msg) => ({
      ...msg,
      // A message persisted mid-stream must never reload as if it were still
      // generating — that would leave the typing indicator spinning forever.
      isGenerating: false,
      // Same for a tool that was still running when the page went away: it
      // never finished, so it must not come back pulsing "working…".
      ...(msg.toolExecutions
        ? {
            toolExecutions: msg.toolExecutions.map((t) =>
              t.status === 'running' ? { ...t, status: 'done' as const, ok: false } : t
            ),
          }
        : {}),
      ...(msg.blocks
        ? {
            blocks: msg.blocks.map((b): MessageBlock => {
              if (b.type === 'tool') {
                return {
                  ...b,
                  tool:
                    b.tool.status === 'running'
                      ? { ...b.tool, status: 'done' as const, ok: false }
                      : b.tool,
                };
              }
              if (b.type === 'action') return { ...b, action: settleAction(b.action) };
              if (b.type === 'text') return b;
              return { ...b, isStillThinking: false };
            }),
          }
        : {}),
      ...(msg.agentStatus ? { agentStatus: undefined } : {}),
    })),
  }));
}

export function getStoredConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return sanitizeConversations(parsed);
      }
    }
  } catch (e) {
    console.error('Failed reading conversations from localStorage', e);
  }
  return [];
}

/**
 * Drop the base64 payload of image attachments.
 *
 * Used only as a fallback: images make a conversation big, and localStorage
 * has a hard quota. Losing the pixels from the local mirror is far better than
 * losing the whole conversation, and the backend copy keeps them intact.
 *
 * `keepConversationIds` spares conversations whose images should stay — the
 * backend fallback keeps the chat the user is actually in, and lets the older
 * ones give up their pixels so the store still fits in one request.
 */
export function stripImagePayloads(
  conversations: Conversation[],
  keepConversationIds: Set<string> = new Set()
): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    messages: keepConversationIds.has(conv.id)
      ? conv.messages || []
      : (conv.messages || []).map((msg) =>
          msg.attachments && msg.attachments.length > 0
            ? {
                ...msg,
                attachments: msg.attachments.map((a) =>
                  a.type === 'image' ? { ...a, content: undefined, previewUrl: undefined } : a
                ),
              }
            : msg
        ),
  }));
}

/**
 * Saving used to run on every conversations change — which, during a streaming
 * answer, means every token. That stringifies the entire history, synchronously,
 * hundreds of times per answer: the main thread is blocked while the agent works
 * and the UI stutters. The write is now coalesced, and it is flushed before the
 * page can go away, so nothing is lost.
 */
const STORAGE_DEBOUNCE_MS = 400;
let pendingConversations: Conversation[] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flushStoredConversations(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const pending = pendingConversations;
  pendingConversations = null;
  if (pending) saveStoredConversations(pending);
}

/** Queue a save. The write happens once the stream (or the typing) pauses. */
export function scheduleStoredConversations(conversations: Conversation[]): void {
  pendingConversations = conversations;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(flushStoredConversations, STORAGE_DEBOUNCE_MS);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushStoredConversations);
  window.addEventListener('beforeunload', flushStoredConversations);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStoredConversations();
  });
}

export function saveStoredConversations(conversations: Conversation[]): void {
  const sanitized = sanitizeConversations(conversations);
  try {
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(sanitized));
  } catch (e) {
    // Out of quota, almost always because of attached images. Retry without
    // them so the conversation itself still survives a reload.
    try {
      localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(stripImagePayloads(sanitized)));
    } catch (retryError) {
      console.error('Failed saving conversations to localStorage', retryError);
    }
  }
}

export function getStoredActiveChatId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_CHAT);
  } catch (e) {
    return null;
  }
}

export function saveStoredActiveChatId(chatId: string | null): void {
  try {
    if (chatId) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, chatId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_CHAT);
    }
  } catch (e) {}
}

export function generateTitleFromPrompt(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return 'New Chat';
  let cleaned = prompt
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^(can you|please|help me with|how to|what is|tell me about|write a|create a)\s+/i, '');

  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return 'New Chat';

  let title = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  if (title.length > 32) {
    title = title.slice(0, 32).trim() + '...';
  }
  return title || 'New Chat';
}

export function createNewConversation(
  defaultProviderId: string = 'provider-vyce',
  defaultModelId: string = 'agnes-3.0-flash'
): Conversation {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    title: 'New Chat',
    messages: [],
    selectedProviderId: defaultProviderId,
    selectedModelId: defaultModelId,
    thinkingLevel: 'Auto',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
