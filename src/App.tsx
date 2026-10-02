import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { PanelLeft } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { ChatInput } from './components/ChatInput';
import { SettingsModal } from './components/SettingsModal';
import { MoviePlayerModal } from './components/MoviePlayerModal';
import { AgentControls } from './components/AgentControls';
import { WorkspaceDialog } from './components/WorkspaceDialog';
import { WorkspacePanel } from './components/WorkspacePanel';
import {
  AgentAction,
  AgentConfig,
  AgentWorkspace,
  Conversation,
  Message,
  MessageBlock,
  Provider,
  Theme,
  ThinkingLevel,
  Attachment,
  ToolExecution,
} from './types';
import {
  createNewConversation,
  generateTitleFromPrompt,
  getStoredActiveChatId,
  getStoredConversations,
  getStoredProviders,
  getStoredTheme,
  saveStoredActiveChatId,
  saveStoredConversations,
  saveStoredProviders,
  saveStoredTheme,
} from './services/storage';
import {
  streamChatCompletion,
  fetchBackendSettings,
  saveBackendSettings,
  fetchBackendConversations,
  saveBackendConversations,
  generateAIChatTitle,
} from './services/api';
import {
  answerApproval,
  deleteWorkspace as deleteAgentWorkspace,
  getAgentConfig,
  listWorkspaces,
  updateWorkspace as updateAgentWorkspace,
} from './services/agentApi';
import { runAgentTurn } from './agent/runAgentTurn';
import { collectActivity } from './agent/format';
import { SmoothStreamer } from './utils/smoothStream';

export const App: React.FC = () => {
  // Theme state
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  // Providers state
  const [providers, setProviders] = useState<Provider[]>(() => getStoredProviders());

  // Remember last selected provider & model across all chats
  const [lastSelectedProviderId, setLastSelectedProviderId] = useState<string>('provider-gemini');
  const [lastSelectedModelId, setLastSelectedModelId] = useState<string>('models/gemini-3.5-flash');

  // Sidebar collapse & mobile drawer state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Settings Modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Agent mode: server capabilities, the workspaces, and the dialog / files panel
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesRefresh, setFilesRefresh] = useState(0);

  // FlixRaid Movie Player Modal state
  const [activeMoviePlayer, setActiveMoviePlayer] = useState<{
    isOpen: boolean;
    mediaId: string;
    mediaType: 'movie' | 'tv' | string;
    title?: string;
  }>({
    isOpen: false,
    mediaId: '',
    mediaType: 'movie',
  });

  // Backend save debouncer ref
  const backendSaveTimerRef = useRef<any>(null);

  // Has the server's copy of the conversations been READ yet?
  // Until it has, this tab's local state (which is just one empty chat in a fresh browser
  // profile) must never be pushed over it — that is how a slow first request used to wipe
  // the saved chats.
  const [backendHydrated, setBackendHydrated] = useState(false);

  // Fetch settings and conversations from Backend on mount
  useEffect(() => {
    fetchBackendSettings().then((backendSettings) => {
      if (backendSettings) {
        if (Array.isArray(backendSettings.providers) && backendSettings.providers.length > 0) {
          setProviders(backendSettings.providers);
          saveStoredProviders(backendSettings.providers);
        }
        if (backendSettings.theme) {
          setTheme(backendSettings.theme);
          saveStoredTheme(backendSettings.theme);
        }
        if (backendSettings.lastSelectedProviderId) {
          setLastSelectedProviderId(backendSettings.lastSelectedProviderId);
        }
        if (backendSettings.lastSelectedModelId) {
          setLastSelectedModelId(backendSettings.lastSelectedModelId);
        }
      }
    });

    let cancelled = false;
    const RETRY_MS = [2000, 4000, 8000, 15000];
    const hydrate = async (attempt = 0) => {
      const data = await fetchBackendConversations();
      if (cancelled) return;
      if (data) {
        if (Array.isArray(data.conversations) && data.conversations.length > 0) {
          setConversations(data.conversations);
          saveStoredConversations(data.conversations);
          if (data.activeChatId) {
            setActiveChatId(data.activeChatId);
            saveStoredActiveChatId(data.activeChatId);
          }
        } else {
          const local = getStoredConversations();
          if (local.length > 0) {
            saveBackendConversations(local, getStoredActiveChatId());
          }
        }
        setBackendHydrated(true);
      } else if (attempt < RETRY_MS.length) {
        // The server did not answer (starting up, a proxy hiccup): try again rather than
        // guessing — saving before we have read it could overwrite what it holds.
        setTimeout(() => hydrate(attempt + 1), RETRY_MS[attempt]);
      }
    };
    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Conversations state
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const stored = getStoredConversations();
    if (stored.length > 0) return stored;
    // Start with one fresh empty conversation
    const initial = createNewConversation('provider-gemini', 'models/gemini-3.5-flash');
    saveStoredConversations([initial]);
    return [initial];
  });

  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    const savedId = getStoredActiveChatId();
    const stored = getStoredConversations();
    if (savedId && stored.some((c) => c.id === savedId)) {
      return savedId;
    }
    return stored[0]?.id || null;
  });

  // Chat Input & Streaming state
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const contentStreamerRef = useRef<SmoothStreamer | null>(null);
  const thinkingStreamerRef = useRef<SmoothStreamer | null>(null);

  // Sync theme to document element
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      // System
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      if (mediaQuery.matches) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }

      const handler = (e: MediaQueryListEvent) => {
        if (theme === 'system') {
          if (e.matches) root.classList.add('dark');
          else root.classList.remove('dark');
        }
      };
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [theme]);

  // Persist conversations to both LocalStorage and Backend Disk
  useEffect(() => {
    saveStoredConversations(conversations);
    // Not before the server's own copy has been read (see backendHydrated above).
    if (!backendHydrated) return;
    if (backendSaveTimerRef.current) clearTimeout(backendSaveTimerRef.current);
    backendSaveTimerRef.current = setTimeout(() => {
      saveBackendConversations(conversations, activeChatId);
    }, 400);
    return () => {
      if (backendSaveTimerRef.current) clearTimeout(backendSaveTimerRef.current);
    };
  }, [conversations, activeChatId, backendHydrated]);

  // Persist activeChatId
  useEffect(() => {
    saveStoredActiveChatId(activeChatId);
  }, [activeChatId]);

  // Find active conversation
  const activeConversation = useMemo(() => {
    return (
      conversations.find((c) => c.id === activeChatId) ||
      conversations[0] ||
      null
    );
  }, [conversations, activeChatId]);

  // Ensure activeChatId is valid
  useEffect(() => {
    if (!activeChatId && conversations.length > 0) {
      setActiveChatId(conversations[0].id);
    }
  }, [activeChatId, conversations]);

  // Get active provider & model
  const activeProvider = useMemo(() => {
    if (!activeConversation) return providers[0];
    const found = providers.find((p) => p.id === activeConversation.selectedProviderId);
    return found || providers[0];
  }, [providers, activeConversation]);

  const activeModelId = useMemo(() => {
    if (!activeConversation || !activeProvider) return 'agnes-3.0-flash';
    const exists = activeProvider.models.some(
      (m) => m.id === activeConversation.selectedModelId
    );
    if (exists) return activeConversation.selectedModelId;
    return activeProvider.models[0]?.id || 'agnes-3.0-flash';
  }, [activeConversation, activeProvider]);

  // Handle Theme Change
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    saveStoredTheme(newTheme);
    saveBackendSettings({
      theme: newTheme,
      providers,
      lastSelectedProviderId,
      lastSelectedModelId,
    });
  };

  // Handle Save Providers from Settings
  const handleSaveProviders = (newProviders: Provider[]) => {
    setProviders(newProviders);
    saveStoredProviders(newProviders);
    saveBackendSettings({
      providers: newProviders,
      theme,
      lastSelectedProviderId,
      lastSelectedModelId,
    });
  };

  // Create New Chat: retains the exact model, provider and thinking level
  const handleNewChat = () => {
    if (isLoading && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const currentProvId = activeConversation?.selectedProviderId || lastSelectedProviderId || providers[0]?.id || 'provider-gemini';
    const currentModId = activeConversation?.selectedModelId || lastSelectedModelId || providers[0]?.models?.[0]?.id || 'models/gemini-3.5-flash';
    const currentThinking = activeConversation?.thinkingLevel || 'Auto';

    const newChat = createNewConversation(currentProvId, currentModId);
    newChat.thinkingLevel = currentThinking;
    // Starting another chat while in Agent mode keeps you in Agent mode, in the same workspace.
    newChat.agentMode = activeConversation?.agentMode;
    newChat.agentWorkspaceId = activeConversation?.agentWorkspaceId ?? null;

    setConversations((prev) => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    setInput('');
    setIsLoading(false);
  };

  // Switch Chat
  const handleSelectChat = (id: string) => {
    if (isLoading && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setActiveChatId(id);
    setInput('');
    setIsLoading(false);
  };

  // Rename Chat
  const handleRenameChat = (id: string, newTitle: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle, updatedAt: Date.now() } : c))
    );
  };

  // Delete Chat
  const handleDeleteChat = (id: string) => {
    // Computed outside the updater: a `setState` updater must be pure, and
    // calling setActiveChatId from inside it runs twice under StrictMode.
    const remaining = conversations.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const currentProvId = lastSelectedProviderId || providers[0]?.id || 'provider-gemini';
      const currentModId = lastSelectedModelId || providers[0]?.models?.[0]?.id || 'models/gemini-3.5-flash';
      const fresh = createNewConversation(currentProvId, currentModId);
      setConversations([fresh]);
      setActiveChatId(fresh.id);
      return;
    }
    setConversations(remaining);
    if (activeChatId === id) setActiveChatId(remaining[0].id);
  };

  // Model & Thinking selection
  const handleSelectModel = (providerId: string, modelId: string) => {
    setLastSelectedProviderId(providerId);
    setLastSelectedModelId(modelId);

    // Persist to backend settings
    saveBackendSettings({
      providers,
      theme,
      lastSelectedProviderId: providerId,
      lastSelectedModelId: modelId,
    });

    if (!activeConversation) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? {
              ...c,
              selectedProviderId: providerId,
              selectedModelId: modelId,
              updatedAt: Date.now(),
            }
          : c
      )
    );
  };

  const handleSelectThinkingLevel = (level: ThinkingLevel) => {
    if (!activeConversation) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? {
              ...c,
              thinkingLevel: level,
              updatedAt: Date.now(),
            }
          : c
      )
    );
  };

  // Stop Generation
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    contentStreamerRef.current?.flushImmediate();
    thinkingStreamerRef.current?.flushImmediate();
    setIsLoading(false);
  };

  // Keyboard shortcut: Esc to stop generation
  useEffect(() => {
    if (!isLoading) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleStop();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoading]);

  // Toggle Pin Chat
  const handleTogglePinChat = (id: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, isPinned: !c.isPinned, updatedAt: Date.now() } : c
      )
    );
  };

  // ---- Agent mode ------------------------------------------------------------
  const refreshAgent = useCallback(async () => {
    try {
      setAgentConfig(await getAgentConfig());
    } catch {
      /* an older server without agent routes: the toggle explains itself on first use */
    }
    try {
      setWorkspaces(await listWorkspaces());
      setWorkspacesLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshAgent();
  }, [refreshAgent]);

  const patchActive = (patch: Partial<Conversation>) => {
    if (!activeConversation) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversation.id ? { ...c, ...patch, updatedAt: Date.now() } : c))
    );
  };

  // A workspace that was deleted elsewhere must not stay selected.
  useEffect(() => {
    if (!workspacesLoaded) return;
    setConversations((prev) => {
      const ids = new Set(workspaces.map((w) => w.id));
      return prev.some((c) => c.agentWorkspaceId && !ids.has(c.agentWorkspaceId))
        ? prev.map((c) => (c.agentWorkspaceId && !ids.has(c.agentWorkspaceId) ? { ...c, agentWorkspaceId: null } : c))
        : prev;
    });
  }, [workspaces, workspacesLoaded]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeConversation?.agentWorkspaceId) || null,
    [workspaces, activeConversation?.agentWorkspaceId]
  );

  const handleToggleAgent = () => {
    const turningOn = !activeConversation?.agentMode;
    patchActive({ agentMode: turningOn });
    if (!turningOn) setFilesOpen(false);
    // Turning it on with nothing to work in: go straight to creating a workspace.
    if (turningOn && !activeConversation?.agentWorkspaceId && workspaces.length === 0) setWorkspaceDialogOpen(true);
    else if (turningOn && !activeConversation?.agentWorkspaceId && workspaces.length > 0) {
      patchActive({ agentMode: true, agentWorkspaceId: workspaces[0].id });
    }
  };

  const handleWorkspaceCreated = async (ws: AgentWorkspace) => {
    await refreshAgent();
    patchActive({ agentMode: true, agentWorkspaceId: ws.id });
    setWorkspaceDialogOpen(false);
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteAgentWorkspace(id);
    } catch (e: any) {
      alert(e?.message || 'Could not delete the workspace.');
      return;
    }
    await refreshAgent();
    setConversations((prev) => prev.map((c) => (c.agentWorkspaceId === id ? { ...c, agentWorkspaceId: null } : c)));
  };

  const handleToggleAutoRun = async (id: string, autoRun: boolean) => {
    try {
      await updateAgentWorkspace(id, { autoRun });
    } catch (e: any) {
      alert(e?.message || 'Could not change that setting.');
    }
    refreshAgent();
  };

  const handleAgentApproval = async (action: AgentAction, allow: boolean, always: boolean) => {
    if (!action.approval) return;
    try {
      await answerApproval(action.approval.key, {
        allow,
        always,
        workspaceId: activeConversation?.agentWorkspaceId || undefined,
      });
      if (always) refreshAgent();
    } catch {
      /* the run already ended — nothing is waiting any more */
    }
  };

  // Send Message
  const handleSendMessage = async (
    textToSend?: string,
    attachmentsToSend?: Attachment[],
    webSearchEnabled: boolean = true,
    /**
     * The message list this send should build on.
     *
     * Retry / Edit / Regenerate first TRIM the conversation and then send. They
     * used to do that with `setConversations(trim)` followed by a 50ms timeout
     * calling this function — but this function is re-created every render and
     * closes over the render's `activeConversation`, so the timeout ran the
     * STALE instance and rebuilt the list from the untrimmed messages. The
     * removed turns came straight back and the transcript grew instead of
     * resetting. Passing the list in makes trim-and-send a single atomic step.
     */
    baseMessages?: Message[]
  ) => {
    const rawText = (textToSend !== undefined ? textToSend : input).trim();
    const currentAttachments = attachmentsToSend || [];

    if (!rawText && currentAttachments.length === 0) return;
    if (!activeConversation || isLoading) return;

    const existingMessages = baseMessages || activeConversation.messages;

    if (!activeProvider) {
      alert('Please configure at least one provider in Settings.');
      return;
    }

    // Agent mode works IN a workspace. Without one, ask for it (the typed text stays in the box).
    const agentWorkspace = activeConversation.agentMode
      ? workspaces.find((w) => w.id === activeConversation.agentWorkspaceId)
      : undefined;
    if (activeConversation.agentMode && !agentWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }

    const messageContent = rawText || (currentAttachments[0] ? `Attached file: ${currentAttachments[0].name}` : '');

    // User message
    const userMessage: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      role: 'user',
      content: messageContent,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      createdAt: Date.now(),
    };

    // Assistant placeholder
    const assistantMessageId = `msg-ai-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isGenerating: true,
      blocks: [],
      toolExecutions: [],
      ...(agentWorkspace ? { agent: true } : {}),
    };

    // Auto-update conversation title: use quick fallback first, then update with AI-generated title
    const isFirstUserMessage = existingMessages.filter((m) => m.role === 'user').length === 0;
    const shouldAutoName = isFirstUserMessage || !activeConversation.title || activeConversation.title === 'New Chat';
    const initialTitle = shouldAutoName
      ? generateTitleFromPrompt(messageContent)
      : activeConversation.title;

    if (shouldAutoName) {
      const convId = activeConversation.id;
      generateAIChatTitle({
        provider: activeProvider,
        model: activeModelId,
        message: messageContent,
      }).then((aiTitle) => {
        if (aiTitle) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId ? { ...c, title: aiTitle, updatedAt: Date.now() } : c
            )
          );
        }
      });
    }

    const updatedMessages = [...existingMessages, userMessage, assistantMessage];

    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? {
              ...c,
              title: initialTitle,
              messages: updatedMessages,
              updatedAt: Date.now(),
            }
          : c
      )
    );

    setInput('');
    setIsLoading(true);

    // The web tools are handed to the MODEL, not run here. It decides what to
    // search for, which pages to open and when it has enough — the server
    // streams each tool it runs back as a `tool` event, and `upsertTool` records
    // it on the assistant message so the chat shows the research trail live.
    let attachmentsContext = '';
    if (currentAttachments.length > 0) {
      const parts = currentAttachments.map((att) => {
        if (att.type === 'image') {
          return `[Attached Image: ${att.name}]`;
        }
        return `[Attached File: ${att.path || att.name}]\n\`\`\`\n${att.content || ''}\n\`\`\``;
      });
      attachmentsContext = `[Attached Context from User]:\n${parts.join('\n\n')}\n[End of Attached Context]\n\n`;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const augmentedPrompt = `${attachmentsContext}${messageContent}`.trim();

    // Messages history to send
    const historyPayload: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      ...existingMessages.map((m) => ({
        role: m.role === 'tool' ? ('user' as const) : (m.role as 'user' | 'assistant' | 'system'),
        content: m.content,
      })),
      { role: 'user' as const, content: augmentedPrompt },
    ];

    // ---- Agent mode: the model works in the workspace with real tools --------
    if (agentWorkspace) {
      const convId = activeConversation.id;
      const patchAssistant = (patch: Partial<Message>) =>
        setConversations((prev) =>
          prev.map((c) =>
            c.id !== convId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) => (m.id === assistantMessageId ? { ...m, ...patch } : m)),
                  updatedAt: Date.now(),
                }
          )
        );
      const MUTATING = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_file', 'move_file', 'create_dir', 'run_command']);
      let settledMutations = 0;

      await runAgentTurn({
        provider: activeProvider,
        model: activeModelId,
        thinkingLevel: activeConversation.thinkingLevel,
        messages: historyPayload,
        workspaceId: agentWorkspace.id,
        activity: collectActivity(existingMessages),
        signal: controller.signal,
        onStreamers: (text, thinking) => {
          contentStreamerRef.current = text;
          thinkingStreamerRef.current = thinking;
        },
        onUpdate: (snap, status) => {
          patchAssistant({
            content: snap.content,
            thinkingContent: snap.thinkingContent,
            blocks: snap.blocks,
            agent: true,
            agentRun: snap.agentRun,
            agentStatus: status,
          });
          // keep an open Files panel live while the agent works
          const settled = snap.blocks.filter(
            (b) => b.type === 'action' && MUTATING.has(b.action.tool) && (b.action.status === 'done' || b.action.status === 'error')
          ).length;
          if (settled !== settledMutations) {
            settledMutations = settled;
            setFilesRefresh((n) => n + 1);
          }
        },
        onFinish: (snap, error) => {
          patchAssistant({
            content: snap.content || (error ? 'Unable to complete the request.' : ''),
            thinkingContent: snap.thinkingContent,
            blocks: snap.blocks,
            agent: true,
            agentRun: snap.agentRun,
            agentStatus: undefined,
            isGenerating: false,
            ...(error ? { error } : {}),
          });
          setIsLoading(false);
          abortControllerRef.current = null;
          setFilesRefresh((n) => n + 1);
        },
      });
      return;
    }

    // Tool activity and chronological blocks for THIS turn.
    let toolExecutions: ToolExecution[] = [];
    let messageBlocks: MessageBlock[] = [];
    let fullAssistantContent = '';
    let fullAssistantThinking = '';
    let isInsideThinkTag = false;
    let thinkingStartTime: number | null = null;
    let totalThinkingDurationSeconds: number | null = null;

    const syncMessageState = () => {
      const snapTools = toolExecutions.slice();
      const snapBlocks = messageBlocks.slice();
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== activeConversation.id) return c;
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: fullAssistantContent,
                    thinkingContent: fullAssistantThinking || undefined,
                    toolExecutions: snapTools,
                    blocks: snapBlocks,
                  }
                : m
            ),
            updatedAt: Date.now(),
          };
        })
      );
    };

    const appendThinkingTokens = (tokens: string) => {
      if (!tokens) return;
      if (!thinkingStartTime) thinkingStartTime = Date.now();
      fullAssistantThinking += tokens;

      const lastIdx = messageBlocks.length - 1;
      const lastBlock = lastIdx >= 0 ? messageBlocks[lastIdx] : null;

      if (lastBlock && lastBlock.type === 'thinking') {
        // ALWAYS append to current thinking block — NEVER split!
        lastBlock.content += tokens;
        messageBlocks = [...messageBlocks];
      } else {
        // Only if previous item was a tool or start of turn, create ONE thinking block
        messageBlocks = [
          ...messageBlocks,
          {
            id: `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'thinking',
            content: tokens,
            isStillThinking: true,
          },
        ];
      }
      syncMessageState();
    };

    const markThinkingDone = () => {
      thinkingStreamer.flushImmediate();
      if (thinkingStartTime && !totalThinkingDurationSeconds) {
        totalThinkingDurationSeconds = Math.max(1, Math.round((Date.now() - thinkingStartTime) / 1000));
      }
      let changed = false;
      messageBlocks = messageBlocks.map((b) => {
        if (b.type === 'thinking' && b.isStillThinking) {
          changed = true;
          return {
            ...b,
            isStillThinking: false,
            duration: b.duration || totalThinkingDurationSeconds || 1,
          };
        }
        return b;
      });
      if (changed) {
        syncMessageState();
      }
    };

    const upsertTool = (tool: ToolExecution) => {
      // If a tool begins/runs, any current thinking phase has concluded
      markThinkingDone();

      const idx = toolExecutions.findIndex((t) => t.id === tool.id);
      toolExecutions =
        idx === -1
          ? [...toolExecutions, tool]
          : toolExecutions.map((t, i) => (i === idx ? { ...t, ...tool } : t));

      const bIdx = messageBlocks.findIndex((b) => b.type === 'tool' && b.id === tool.id);
      if (bIdx === -1) {
        messageBlocks = [...messageBlocks, { id: tool.id, type: 'tool', tool }];
      } else {
        messageBlocks = messageBlocks.map((b, i) =>
          i === bIdx && b.type === 'tool' ? { ...b, tool: { ...b.tool, ...tool } } : b
        );
      }

      syncMessageState();
    };

    // Smooth streamers for token-by-token fluid display
    const contentStreamer = new SmoothStreamer((tokens) => {
      markThinkingDone();
      fullAssistantContent += tokens;
      syncMessageState();
    });
    contentStreamerRef.current = contentStreamer;

    const thinkingStreamer = new SmoothStreamer((tokens) => {
      appendThinkingTokens(tokens);
    });
    thinkingStreamerRef.current = thinkingStreamer;

    await streamChatCompletion({
      provider: activeProvider,
      model: activeModelId,
      thinkingLevel: activeConversation.thinkingLevel,
      messages: historyPayload,
      toolsEnabled: Boolean(webSearchEnabled !== false),
      signal: controller.signal,
      onTool: upsertTool,
      onThinking: (chunk) => {
        thinkingStreamer.push(chunk);
      },
      onChunk: (chunk) => {
        let text = chunk;
        if (text.includes('<think>') || text.includes('<thought>')) {
          isInsideThinkTag = true;
          text = text.replace(/<think>|<thought>/gi, '');
        }

        if (isInsideThinkTag) {
          if (text.includes('</think>') || text.includes('</thought>')) {
            const parts = text.split(/<\/think>|<\/thought>/i);
            thinkingStreamer.push(parts[0]);
            thinkingStreamer.finish();
            isInsideThinkTag = false;
            markThinkingDone();
            if (parts.slice(1).join('')) {
              contentStreamer.push(parts.slice(1).join(''));
            }
          } else {
            thinkingStreamer.push(text);
          }
        } else {
          markThinkingDone();
          contentStreamer.push(text);
        }
      },
      onError: (errMsg) => {
        thinkingStreamer.flushImmediate();
        contentStreamer.flushImmediate();
        if (thinkingStartTime && !totalThinkingDurationSeconds) {
          totalThinkingDurationSeconds = Math.max(1, Math.round((Date.now() - thinkingStartTime) / 1000));
        }
        const finalBlocks = messageBlocks.map((b) =>
          b.type === 'thinking'
            ? { ...b, isStillThinking: false, duration: b.duration || totalThinkingDurationSeconds || 1 }
            : b
        );
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== activeConversation.id) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      error: errMsg,
                      isGenerating: false,
                      content:
                        fullAssistantContent ||
                        'Unable to complete request. Please verify provider settings or retry.',
                      blocks: finalBlocks,
                      ...(totalThinkingDurationSeconds ? { thinkingDuration: totalThinkingDurationSeconds } : {}),
                    }
                  : m
              ),
              updatedAt: Date.now(),
            };
          })
        );
        setIsLoading(false);
        abortControllerRef.current = null;
      },
      onDone: () => {
        thinkingStreamer.finish();
        contentStreamer.finish();
        if (thinkingStartTime && !totalThinkingDurationSeconds) {
          totalThinkingDurationSeconds = Math.max(1, Math.round((Date.now() - thinkingStartTime) / 1000));
        }
        const finalBlocks = messageBlocks.map((b) =>
          b.type === 'thinking'
            ? { ...b, isStillThinking: false, duration: b.duration || totalThinkingDurationSeconds || 1 }
            : b
        );
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== activeConversation.id) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      isGenerating: false,
                      blocks: finalBlocks,
                      ...(totalThinkingDurationSeconds ? { thinkingDuration: totalThinkingDurationSeconds } : {}),
                    }
                  : m
              ),
            };
          })
        );
        setIsLoading(false);
        abortControllerRef.current = null;
      },
    });
  };

  // Retry generation on error
  const handleRetry = async () => {
    if (!activeConversation || isLoading) return;
    const msgs = activeConversation.messages;
    if (msgs.length === 0) return;

    const lastUserIndex = [...msgs].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIndex === -1) return;
    const actualIndex = msgs.length - 1 - lastUserIndex;
    const prompt = msgs[actualIndex].content;

    const trimmed = msgs.slice(0, actualIndex);
    // Trim AND send in one step: the send is handed the trimmed list directly,
    // so it cannot rebuild the transcript from the pre-trim state.
    await handleSendMessage(prompt, undefined, undefined, trimmed);
  };

  // Edit a past user message and regenerate response from that point
  const handleEditUserMessage = async (messageId: string, newContent: string) => {
    if (!activeConversation || isLoading) return;
    const msgs = activeConversation.messages;
    const msgIndex = msgs.findIndex((m) => m.id === messageId);
    if (msgIndex === -1) return;

    // Keep messages before this one
    const trimmed = msgs.slice(0, msgIndex);
    await handleSendMessage(newContent, undefined, undefined, trimmed);
  };

  // Regenerate a specific assistant response
  const handleRegenerateResponse = async (assistantMessageId: string) => {
    if (!activeConversation || isLoading) return;
    const msgs = activeConversation.messages;
    const assistantIndex = msgs.findIndex((m) => m.id === assistantMessageId);
    if (assistantIndex === -1) {
      handleRetry();
      return;
    }

    // Find the user prompt right before this assistant message
    const promptMsg = msgs.slice(0, assistantIndex).reverse().find((m) => m.role === 'user');
    if (!promptMsg) return;

    const userIndex = msgs.findIndex((m) => m.id === promptMsg.id);
    const trimmed = msgs.slice(0, userIndex);

    await handleSendMessage(promptMsg.content, undefined, undefined, trimmed);
  };

  // Continue generation from where it left off
  const handleContinueResponse = () => {
    handleSendMessage('Continue');
  };

  const agentOn = Boolean(activeConversation?.agentMode);
  const agentControlsNode = (
    <AgentControls
      enabled={agentOn}
      onToggle={handleToggleAgent}
      workspaces={workspaces}
      activeWorkspaceId={activeConversation?.agentWorkspaceId ?? null}
      onSelectWorkspace={(id) => patchActive({ agentWorkspaceId: id })}
      onCreate={() => setWorkspaceDialogOpen(true)}
      onDelete={handleDeleteWorkspace}
      onToggleAutoRun={handleToggleAutoRun}
      filesOpen={filesOpen}
      onToggleFiles={() => setFilesOpen((v) => !v)}
      busy={isLoading}
    />
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans">
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onRenameChat={handleRenameChat}
        onDeleteChat={handleDeleteChat}
        onTogglePinChat={handleTogglePinChat}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        isMobileOpen={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
      />

      {/* Main Chat Area (Completely open & transparent, no header) */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Floating Mobile Toggle Button */}
        <div className="lg:hidden absolute top-3 left-3 z-30">
          <button
            onClick={() => setIsMobileSidebarOpen(true)}
            aria-label="Open sidebar"
            className="p-2 rounded-xl bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md shadow-sm border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <PanelLeft className="w-5 h-5 stroke-[1.75]" />
          </button>
        </div>

        {/* Empty Chat State vs Active Chat State */}
        {(!activeConversation || activeConversation.messages.length === 0) ? (
          <div className="flex-1 flex flex-col items-center justify-center w-full px-4 -translate-y-6 sm:-translate-y-8 animate-in fade-in duration-200">
            <div className="text-center mb-6 select-none">
              <h1 className="text-2xl sm:text-3xl font-semibold text-zinc-900 dark:text-zinc-100 tracking-tight mb-2">
                {agentOn ? 'What should we build?' : 'How can I help you today?'}
              </h1>
              <p className="text-xs sm:text-sm text-zinc-400 dark:text-zinc-500">
                {agentOn
                  ? 'Agent mode: I create files, run commands and show you the result.'
                  : 'Ask anything, write code, or explore ideas.'}
              </p>
            </div>

            <ChatInput
              isCentered={true}
              input={input}
              setInput={setInput}
              onSend={(atts) => handleSendMessage(undefined, atts, true)}
              isLoading={isLoading}
              onStop={handleStop}
              placeholder={agentOn ? 'Describe what to build or change…' : 'Ask anything...'}
              providers={providers}
              selectedProviderId={activeConversation?.selectedProviderId || providers[0]?.id}
              selectedModelId={activeModelId}
              thinkingLevel={activeConversation?.thinkingLevel || 'Auto'}
              onSelectModel={handleSelectModel}
              onSelectThinkingLevel={handleSelectThinkingLevel}
              agentControls={agentControlsNode}
            />
          </div>
        ) : (
          <div className="relative flex-1 flex flex-col h-full min-h-0 w-full overflow-hidden">
            {/* Chat Messages View with Far-Right Pinned Scrollbar */}
            <ChatArea
              messages={activeConversation.messages}
              isLoading={isLoading}
              onRetry={handleRetry}
              onEditUserMessage={handleEditUserMessage}
              onRegenerateResponse={handleRegenerateResponse}
              onContinueResponse={handleContinueResponse}
              onAgentApproval={handleAgentApproval}
              agentMode={agentOn}
              onWatchMedia={(id, type, title) => {
                setActiveMoviePlayer({
                  isOpen: true,
                  mediaId: id,
                  mediaType: type,
                  title: title || 'Now Playing',
                });
              }}
            />

            {/* Floating Compact Chat Input at Bottom with subtle bottom fade */}
            <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none pt-10 pb-3 sm:pb-4 px-4 bg-gradient-to-t from-white via-white/85 to-transparent dark:from-zinc-950 dark:via-zinc-950/85 dark:to-transparent">
              <div className="pointer-events-auto">
                <ChatInput
                  isCentered={false}
                  input={input}
                  setInput={setInput}
                  onSend={(atts) => handleSendMessage(undefined, atts, true)}
                  isLoading={isLoading}
                  onStop={handleStop}
                  placeholder={agentOn ? 'Describe what to build or change…' : 'Ask anything...'}
                  providers={providers}
                  selectedProviderId={activeConversation.selectedProviderId || providers[0]?.id}
                  selectedModelId={activeModelId}
                  thinkingLevel={activeConversation.thinkingLevel || 'Auto'}
                  onSelectModel={handleSelectModel}
                  onSelectThinkingLevel={handleSelectThinkingLevel}
                  agentControls={agentControlsNode}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Agent mode: browse the workspace the agent is working in */}
      {agentOn && filesOpen && activeWorkspace && (
        <WorkspacePanel workspace={activeWorkspace} refreshToken={filesRefresh} onClose={() => setFilesOpen(false)} />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        theme={theme}
        onThemeChange={handleThemeChange}
        providers={providers}
        onSaveProviders={handleSaveProviders}
      />

      {/* Agent mode: create a workspace (cloud sandbox or a folder on this machine) */}
      <WorkspaceDialog
        isOpen={workspaceDialogOpen}
        onClose={() => setWorkspaceDialogOpen(false)}
        config={agentConfig}
        onCreated={handleWorkspaceCreated}
        onConfigChanged={refreshAgent}
      />

      {/* FlixRaid Movie & Series Streaming Player Modal */}
      <MoviePlayerModal
        isOpen={activeMoviePlayer.isOpen}
        onClose={() =>
          setActiveMoviePlayer((prev) => ({ ...prev, isOpen: false }))
        }
        mediaId={activeMoviePlayer.mediaId}
        mediaType={activeMoviePlayer.mediaType}
        title={activeMoviePlayer.title}
      />
    </div>
  );
};
