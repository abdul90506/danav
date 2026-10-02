import type { AgentAction, Conversation, MessageBlock, Provider, Theme } from '../types';

const STORAGE_KEYS = {
  CONVERSATIONS: 'danav_chat_history_v2',
  PROVIDERS: 'danav_chat_providers_v2',
  THEME: 'danav_chat_theme_v2',
  ACTIVE_CHAT: 'danav_active_chat_id_v2',
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

export function getStoredProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROVIDERS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // If old mock provider was cached, migrate to Vyce AI
        if (parsed.some((p) => p.apiType === 'mock')) {
          saveStoredProviders(DEFAULT_PROVIDERS);
          return DEFAULT_PROVIDERS;
        }
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed reading providers from localStorage', e);
  }
  return DEFAULT_PROVIDERS;
}

export function saveStoredProviders(providers: Provider[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PROVIDERS, JSON.stringify(providers));
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

export function saveStoredConversations(conversations: Conversation[]): void {
  try {
    const sanitized = sanitizeConversations(conversations);
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(sanitized));
  } catch (e) {
    console.error('Failed saving conversations to localStorage', e);
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
