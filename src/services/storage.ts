import type { AgentAction, Conversation, MessageBlock, Provider, Theme } from '../types';

const STORAGE_KEYS = {
  CONVERSATIONS: 'danav_chat_history_v2',
  PROVIDERS: 'danav_chat_providers_v2',
  THEME: 'danav_chat_theme_v2',
  ACTIVE_CHAT: 'danav_active_chat_id_v2',
  PREVIEW_WIDTH: 'danav_preview_width_v1',
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
      const { apiKey, ...safeProvider } = provider;
      delete safeProvider.clearApiKey;
      return {
        ...safeProvider,
        apiKeyConfigured: Boolean((typeof apiKey === 'string' && apiKey.trim()) || provider.apiKeyConfigured),
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
        return parsed.map((provider: Provider) => {
          const copy = { ...provider };
          delete copy.clearApiKey;
          copy.apiKeyConfigured = Boolean((typeof provider.apiKey === 'string' && provider.apiKey.trim()) || provider.apiKeyConfigured);
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
 */
function stripImagePayloads(conversations: Conversation[]): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    messages: (conv.messages || []).map((msg) =>
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
