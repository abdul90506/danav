import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { PanelLeft, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { ChatInput } from './components/ChatInput';
import { useStable } from './utils/stableCallback';
import { hasOpenPopover } from './utils/useDismissOnOutside';
import { SettingsModal } from './components/SettingsModal';
import { MoviePlayerModal } from './components/MoviePlayerModal';
import { AgentControls } from './components/AgentControls';
import { WorkspaceDialog } from './components/WorkspaceDialog';
import { WorkspacePanel } from './components/WorkspacePanel';
import { PreviewPanel, clampPreviewWidth, defaultPreviewWidth } from './components/PreviewPanel';
import { SandboxManagerDialog } from './components/SandboxManagerDialog';
import {
  AgentAction,
  AgentConfig,
  AgentSummaryModelSelection,
  AgentWorkspace,
  ChatMessageContent,
  Conversation,
  Message,
  MessageBlock,
  Provider,
  SandboxStatus,
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
  getStoredPreviewWidth,
  getStoredProviders,
  getStoredTheme,
  saveStoredActiveChatId,
  saveStoredConversations,
  scheduleStoredConversations,
  saveStoredPreviewWidth,
  saveStoredProviders,
  saveStoredTheme,
  sanitizeProvidersForClient,
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
  AgentApiError,
  answerApproval,
  deleteWorkspace as deleteAgentWorkspace,
  getAgentConfig,
  getSandboxStatus,
  listWorkspaces,
  stopAgentRun,
  updateWorkspace as updateAgentWorkspace,
  wakeWorkspace,
} from './services/agentApi';
import { runAgentTurn } from './agent/runAgentTurn';
import { collectActivity } from './agent/format';
import { SmoothStreamer } from './utils/smoothStream';
import { buildMessageContent } from './utils/messageContent';
import { savePreviewAccessCode } from './services/previewAuth';

/**
 * What a resumed turn says to the model: nothing but the fact that it should go on.
 *
 * The important part is what is NOT here — no "you were stopped", no "resume from
 * step one", no retelling of the task. A model told it was interrupted starts by
 * re-checking the world; a model that simply carries on does the next step. Its own
 * work so far is in the message right above this one, in its own voice (see
 * workSoFar below), and the server adds the plan and the files it already changed.
 */
const RESUME_NOTE = '[continue]';

/** A small, plain cue that the user typed a continuation rather than a new request. */
const isContinuationText = (text: string): boolean => {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?\s]+$/g, '');
  if (!t || t.length > 30) return false;
  return [
    'continue', 'carry on', 'go on', 'keep going', 'keep going please', 'proceed',
    'resume', 'finish it', 'finish the task', 'finish this', 'complete it', 'go ahead',
    'aage karo', 'aage badho', 'continue karo', 'kar do', 'karte raho', 'chalo aage',
    'baqi karo', 'baki karo', 'poora karo', 'pura karo', 'mukammal karo',
  ].includes(t);
};

const isProviderBusyStatus = (status?: string): boolean =>
  Boolean(status && /provider\s+(?:is\s+)?busy/i.test(status));

export const App: React.FC = () => {
  // Theme state
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  // Providers state
  const [providers, setProviders] = useState<Provider[]>(() => getStoredProviders());
  const [agentSummaryModel, setAgentSummaryModel] = useState<AgentSummaryModelSelection | null>(null);

  // Remember last selected provider & model across all chats
  const [lastSelectedProviderId, setLastSelectedProviderId] = useState<string>('provider-gemini');
  const [lastSelectedModelId, setLastSelectedModelId] = useState<string>('models/gemini-3.5-flash');

  // Sidebar collapse & mobile drawer state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // The running app the agent built, shown docked on the right (null = closed).
  // `reloadKey` is the load token: the panel keys its frame on it, so raising it
  // is what makes the frame navigate again.
  const [previewTarget, setPreviewTarget] = useState<{ url: string; title?: string; reloadKey?: number } | null>(null);
  /** Every open, refresh and sandbox wake gets its own token. Never reused. */
  const previewTokenRef = useRef(0);
  /**
   * The chat's way of telling the docked preview that the app it shows has moved
   * on. A ref, not a direct call: the send path is declared before the preview
   * state, and a closure over a stale `previewTarget` would refresh the wrong
   * panel — or none at all.
   */
  const previewRefreshRef = useRef<((url?: string, title?: string) => void) | null>(null);
  // How the chat / preview split is divided. Remembered across reloads.
  const [previewWidth, setPreviewWidth] = useState(() => {
    const stored = getStoredPreviewWidth();
    if (typeof window === 'undefined') return stored ?? 620;
    return stored === null ? defaultPreviewWidth(window.innerWidth) : clampPreviewWidth(stored, window.innerWidth);
  });
  /**
   * True while WE hid the sidebar to make room for the preview. Closing the
   * preview then puts it back — but a sidebar the user hid themselves stays hid.
   */
  const sidebarHiddenForPreviewRef = useRef(false);

  // Settings Modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Temporary access gate for a public sandbox preview. The token is entered by
  // the user and kept only in this tab's sessionStorage; it is never bundled.
  const [previewAuthRequired, setPreviewAuthRequired] = useState(false);
  const [previewAuthenticated, setPreviewAuthenticated] = useState(false);
  const [previewAuthChecking, setPreviewAuthChecking] = useState(true);
  const [previewTokenInput, setPreviewTokenInput] = useState('');
  const [previewAuthError, setPreviewAuthError] = useState('');
  /**
   * A short, in-page notice.
   *
   * These messages used to be `alert()`: a dialog is blocked inside the sandboxed
   * preview iframe, so "configure a provider first" (and a failed workspace
   * delete) produced no feedback at all — the button just looked dead.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [previewAuthBusy, setPreviewAuthBusy] = useState(false);

  // Agent mode: server capabilities, the workspaces, and the dialog / files panel
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesRefresh, setFilesRefresh] = useState(0);
  // Account-wide sandbox manager (sees sandboxes Danav no longer tracks).
  const [sandboxesOpen, setSandboxesOpen] = useState(false);
  // What the active workspace's own sandbox is doing right now.
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);

  /**
   * Only one revealed surface at a time.
   *
   * Opening the file panel, the workspaces dialog or the sandbox manager used to
   * leave whatever was already open sitting behind it — you had to close one
   * before reading the next. The most recently opened one wins and the others
   * close themselves; each toggle stays a plain on/off for the button that owns it.
   */
  const openedOrderRef = useRef<string[]>([]);
  const revealedSurfaces: Array<[string, boolean, (open: boolean) => void]> = [
    ['settings', isSettingsOpen, setIsSettingsOpen],
    ['workspaceDialog', workspaceDialogOpen, setWorkspaceDialogOpen],
    ['files', filesOpen, setFilesOpen],
    ['sandboxes', sandboxesOpen, setSandboxesOpen],
  ];
  const revealedSignature = revealedSurfaces.map(([, open]) => (open ? '1' : '0')).join('');
  useEffect(() => {
    const opened = new Set(revealedSurfaces.filter(([, open]) => open).map(([name]) => name));
    // Remember the newest opener, then drop everything older.
    openedOrderRef.current = [...openedOrderRef.current.filter((name) => opened.has(name)), ...[...opened].filter((name) => !openedOrderRef.current.includes(name))];
    const winner = openedOrderRef.current[openedOrderRef.current.length - 1];
    if (opened.size <= 1 || !winner) return;
    for (const [name, open, setOpen] of revealedSurfaces) if (open && name !== winner) setOpen(false);
  }, [revealedSignature]);


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
  /** The server's copy of the chat store stopped accepting updates. */
  const [backendSaveFailed, setBackendSaveFailed] = useState(false);

  // Has the server's copy of the conversations been READ yet?
  // Until it has, this tab's local state (which is just one empty chat in a fresh browser
  // profile) must never be pushed over it — that is how a slow first request used to wipe
  // the saved chats.
  const [backendHydrated, setBackendHydrated] = useState(false);

  // Discover whether this backend requires the one-time sandbox access code.
  // The check endpoint is intentionally safe to call before authentication.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/preview-auth/check', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.status === 401 && result?.required) {
          setPreviewAuthRequired(true);
          setPreviewAuthenticated(false);
          // Do not revive an old browser-stored provider key in this isolated
          // preview. Keep provider definitions, but require a fresh key.
          const safeProviders = sanitizeProvidersForClient(getStoredProviders())
            .map((provider) => ({ ...provider, apiKeyConfigured: false, apiKeyCount: 0 }));
          setProviders(safeProviders);
          saveStoredProviders(safeProviders);
        } else if (response.ok) {
          setPreviewAuthRequired(Boolean(result?.required));
          setPreviewAuthenticated(Boolean(result?.authenticated));
        } else {
          // If the preview backend is still booting, let the app render and let
          // its normal API retry/hydration path recover once the server is ready.
          setPreviewAuthRequired(false);
          setPreviewAuthenticated(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewAuthRequired(false);
        setPreviewAuthenticated(true);
      })
      .finally(() => {
        if (!cancelled) setPreviewAuthChecking(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Fetch settings and conversations only after the temporary preview gate opens.
  useEffect(() => {
    if (!previewAuthenticated) return;
    fetchBackendSettings().then(async (backendSettings) => {
      if (backendSettings) {
        setAgentSummaryModel(backendSettings.agentSummaryModel ?? null);
        if (Array.isArray(backendSettings.providers)) {
          let needsKeyMigration = false;
          const hydratedProviders = backendSettings.providers.map((remoteProvider) => {
            const localProvider = providers.find((candidate) => candidate.id === remoteProvider.id);
            const localKey = typeof localProvider?.apiKey === 'string' ? localProvider.apiKey.trim() : '';
            const sameEndpoint = Boolean(localProvider)
              && String(localProvider?.baseUrl || '').trim().replace(/\/+$/, '') === String(remoteProvider.baseUrl || '').trim().replace(/\/+$/, '')
              && localProvider?.apiType === remoteProvider.apiType;
            if (!previewAuthRequired && !remoteProvider.apiKeyConfigured && localKey && sameEndpoint) {
              needsKeyMigration = true;
              return { ...remoteProvider, apiKey: localKey, apiKeyConfigured: true };
            }
            return remoteProvider;
          });

          // Upgrade credentials that existed only in old browser storage. This
          // is a one-time same-provider/same-endpoint transfer, never a GET response.
          const migrated = !needsKeyMigration || await saveBackendSettings({ providers: hydratedProviders });
          if (migrated) {
            const safeProviders = sanitizeProvidersForClient(hydratedProviders);
            setProviders(safeProviders);
            saveStoredProviders(safeProviders);
          } else {
            // Keep the current tab usable if the backend is temporarily read-only;
            // localStorage remains key-free and a later settings save retries.
            setProviders(providers);
            saveStoredProviders(providers);
          }
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
  }, [previewAuthenticated]);

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
  /** Explicit renames always win over a title request that resolves later. */
  const titleEditRevisionRef = useRef(new Map<string, number>());

  // Chat Input & Streaming state
  /**
   * The draft itself lives in ChatInput. Keeping it here meant a re-render of the
   * whole app — sidebar, both panels and every message — on each keystroke, which
   * is what makes typing lag in a long conversation. The app only needs to say
   * "the draft is gone now", which is what this counter does: bumping it clears
   * the box and puts the caret back.
   */
  const [composerReset, setComposerReset] = useState(0);
  const resetComposer = useCallback(() => setComposerReset((n) => n + 1), []);
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** The selection captured when the current upstream request started. */
  const currentRunSelectionRef = useRef<{
    conversationId: string;
    assistantMessageId: string;
    providerId: string;
    modelId: string;
  } | null>(null);
  /** A model change noticed during a busy backoff, to apply only after the stream stops. */
  const pendingModelRetryRef = useRef<{
    conversationId: string;
    assistantMessageId: string;
    provider: Provider;
    modelId: string;
  } | null>(null);
  /** Synchronous marker for the exact provider-busy backoff window (no render race). */
  const providerBusyRunRef = useRef<{ conversationId: string; assistantMessageId: string } | null>(null);
  /** Agent switch is waiting for the server to release the old workspace lock. */
  const modelRetryWaitRef = useRef<{ conversationId: string; assistantMessageId: string } | null>(null);
  /** Invalidates a model-switch transition when the user stops or changes chats. */
  const modelRetryEpochRef = useRef(0);
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
    // Coalesced, not immediate: this effect fires on every token of a stream.
    scheduleStoredConversations(conversations);
    // Not before the server's own copy has been read (see backendHydrated above).
    if (!backendHydrated) return;
    if (backendSaveTimerRef.current) clearTimeout(backendSaveTimerRef.current);
    backendSaveTimerRef.current = setTimeout(() => {
      void saveBackendConversations(conversations, activeChatId).then((result) => {
        if (!result.ok) setBackendSaveFailed(true);
      });
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

  const latestModelSelectionRef = useRef<{
    conversationId: string | null;
    provider: Provider | undefined;
    modelId: string;
  }>({ conversationId: activeConversation?.id ?? null, provider: activeProvider, modelId: activeModelId });
  latestModelSelectionRef.current = {
    conversationId: activeConversation?.id ?? null,
    provider: activeProvider,
    modelId: activeModelId,
  };

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
  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 7000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  /**
   * A chat that lives only in this browser is something the user has to know
   * about — but saying it on every message would be noise, so it is said once
   * per session. The local copy is still complete; the server copy is not.
   */
  useEffect(() => {
    if (backendSaveFailed) {
      showNotice(
        'Your chats are saved in this browser, but the server copy could not be updated. Settings → Chat Data can export them.'
      );
    }
  }, [backendSaveFailed, showNotice]);

  const handleSaveProviders = async (newProviders: Provider[]): Promise<boolean> => {
    // Persist first so a just-added provider can be used immediately without
    // racing its credential write. Credentials never enter React state/storage.
    const saved = await saveBackendSettings({
      providers: newProviders,
      theme,
      lastSelectedProviderId,
      lastSelectedModelId,
    });
    if (!saved) return false;
    // Re-read only the public settings shape so the exact saved-key count stays
    // accurate without ever receiving the credential values in this browser.
    const storedSettings = await fetchBackendSettings();
    const safeProviders = sanitizeProvidersForClient(
      Array.isArray(storedSettings?.providers) ? storedSettings.providers : newProviders
    );
    setProviders(safeProviders);
    saveStoredProviders(safeProviders);
    setAgentSummaryModel(storedSettings?.agentSummaryModel ?? null);
    return true;
  };

  const handleSaveAgentSummaryModel = async (selection: AgentSummaryModelSelection | null): Promise<boolean> => {
    const saved = await saveBackendSettings({ agentSummaryModel: selection });
    if (!saved) return false;
    const storedSettings = await fetchBackendSettings();
    const safeSelection = storedSettings ? (storedSettings.agentSummaryModel ?? null) : selection;
    setAgentSummaryModel(safeSelection);
    return true;
  };

  /**
   * Re-read the server's conversation store and show exactly what it holds.
   *
   * Used after "Restore previous backup": the restore changes the file, and
   * without this the sidebar would keep displaying the (now replaced) chats that
   * are still in memory — the restore would look like it silently did nothing.
   */
  const handleConversationsRestored = useCallback(async () => {
    const data = await fetchBackendConversations();
    if (!data) return;
    discardPendingModelRetry();
    const previousRun = abortControllerRef.current;
    abortControllerRef.current = null;
    previousRun?.abort();
    setIsLoading(false);
    resetComposer();
    const restored = data.conversations.length > 0 ? data.conversations : [];
    for (const conversation of restored) {
      const revisions = titleEditRevisionRef.current;
      revisions.set(conversation.id, (revisions.get(conversation.id) || 0) + 1);
    }
    setConversations(restored);
    saveStoredConversations(restored);
    const nextActive =
      data.activeChatId && restored.some((c) => c.id === data.activeChatId)
        ? data.activeChatId
        : restored[0]?.id ?? null;
    setActiveChatId(nextActive);
    saveStoredActiveChatId(nextActive);
  }, []);

  // Create New Chat: retains the exact model, provider and thinking level
  const handleNewChat = () => {
    discardPendingModelRetry();
    const previousRun = abortControllerRef.current;
    abortControllerRef.current = null;
    previousRun?.abort();

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
    resetComposer();
    setIsLoading(false);
  };

  // Switch Chat
  const handleSelectChat = (id: string) => {
    // Re-selecting the active chat is only a sidebar interaction; it must not
    // cancel the run or discard an unfinished composer draft.
    if (id === activeChatId) return;
    discardPendingModelRetry();
    const previousRun = abortControllerRef.current;
    abortControllerRef.current = null;
    previousRun?.abort();
    setActiveChatId(id);
    resetComposer();
    setIsLoading(false);
  };

  // Rename Chat
  const handleRenameChat = (id: string, newTitle: string) => {
    const revisions = titleEditRevisionRef.current;
    revisions.set(id, (revisions.get(id) || 0) + 1);
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle, updatedAt: Date.now() } : c))
    );
  };

  // Delete Chat
  const handleDeleteChat = (id: string) => {
    // A run belongs to the active transcript. Deleting that transcript must stop
    // its request before its callbacks can affect the newly selected chat.
    if (activeChatId === id) {
      discardPendingModelRetry();
      const previousRun = abortControllerRef.current;
      abortControllerRef.current = null;
      previousRun?.abort();
      setIsLoading(false);
      resetComposer();
    }
    titleEditRevisionRef.current.delete(id);

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
  const discardPendingModelRetry = () => {
    modelRetryEpochRef.current += 1;
    pendingModelRetryRef.current = null;
    providerBusyRunRef.current = null;
    currentRunSelectionRef.current = null;
    const waiting = modelRetryWaitRef.current;
    modelRetryWaitRef.current = null;
    if (waiting) {
      setConversations((prev) => prev.map((conversation) =>
        conversation.id !== waiting.conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === waiting.assistantMessageId
                  ? { ...message, isGenerating: false, agentStatus: undefined }
                  : message
              ),
            }
      ));
    }
  };

  /**
   * A stream can only move to another model at the provider-busy backoff point:
   * the request already sent upstream cannot be retargeted. Stop its retry loop,
   * finish its local state update, then resume an agent from the same task journal.
   */
  const queueModelRetryForActiveTurn = (provider: Provider, modelId: string) => {
    const run = currentRunSelectionRef.current;
    const latest = latestModelSelectionRef.current;
    if (
      !run ||
      !activeConversation ||
      run.conversationId !== activeConversation.id ||
      latest.conversationId !== run.conversationId
    ) return;

    const previous = pendingModelRetryRef.current;
    if (
      run.providerId === provider.id &&
      run.modelId === modelId &&
      !previous
    ) return;
    if (
      previous?.conversationId === run.conversationId &&
      previous.assistantMessageId === run.assistantMessageId &&
      previous.provider.id === provider.id &&
      previous.modelId === modelId
    ) return;

    pendingModelRetryRef.current = {
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      provider,
      modelId,
    };
    const modelName = provider.models.find((model) => model.id === modelId)?.name || modelId;
    setConversations((prev) => prev.map((conversation) =>
      conversation.id !== run.conversationId
        ? conversation
        : {
            ...conversation,
            messages: conversation.messages.map((message) =>
              message.id === run.assistantMessageId
                ? { ...message, agentStatus: `Switching to ${modelName} for the next attempt…` }
                : message
            ),
          }
    ));
    abortControllerRef.current?.abort();
  };

  const queueLatestSelectionAfterBusyStatus = (
    conversationId: string,
    assistantMessageId: string,
    status?: string
  ) => {
    const isBusy = isProviderBusyStatus(status);
    const currentBusy = providerBusyRunRef.current;
    if (isBusy) {
      providerBusyRunRef.current = { conversationId, assistantMessageId };
    } else if (
      currentBusy?.conversationId === conversationId &&
      currentBusy.assistantMessageId === assistantMessageId
    ) {
      providerBusyRunRef.current = null;
    }
    if (!isBusy) return;
    const run = currentRunSelectionRef.current;
    const latest = latestModelSelectionRef.current;
    if (
      !run ||
      run.conversationId !== conversationId ||
      run.assistantMessageId !== assistantMessageId ||
      latest.conversationId !== conversationId ||
      !latest.provider
    ) return;
    const alreadyQueued = pendingModelRetryRef.current?.assistantMessageId === assistantMessageId;
    if (!alreadyQueued && run.providerId === latest.provider.id && run.modelId === latest.modelId) return;
    queueModelRetryForActiveTurn(latest.provider, latest.modelId);
  };

  const handleSelectModel = (providerId: string, modelId: string) => {
    const nextProvider = providers.find((provider) => provider.id === providerId);
    const conversationId = activeConversation?.id ?? null;
    if (conversationId) {
      latestModelSelectionRef.current = { conversationId, provider: nextProvider, modelId };
      const run = currentRunSelectionRef.current;
      const runMessage = run?.conversationId === conversationId
        ? activeConversation?.messages.find((message) => message.id === run.assistantMessageId)
        : undefined;
      const queuedForRun = pendingModelRetryRef.current?.assistantMessageId === run?.assistantMessageId;
      const busyForRun = providerBusyRunRef.current?.conversationId === conversationId
        && providerBusyRunRef.current?.assistantMessageId === run?.assistantMessageId;
      if (nextProvider && (isProviderBusyStatus(runMessage?.agentStatus) || queuedForRun || busyForRun)) {
        queueModelRetryForActiveTurn(nextProvider, modelId);
      }
    }

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
    discardPendingModelRetry();
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    controller?.abort();
    contentStreamerRef.current?.flushImmediate();
    thinkingStreamerRef.current?.flushImmediate();
    setIsLoading(false);
  };

  // Keyboard shortcut: Esc to stop generation.
  //
  // Escape is shared with everything that can be revealed — a menu, an action
  // row's detail, an open thought. Those come first: the panel closes and the run
  // is left alone. Typing in a field owns Escape too, so renaming a chat or
  // editing a message does not kill a run that is still working.
  useEffect(() => {
    if (!isLoading) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hasOpenPopover()) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
      handleStop();
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
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'preview_auth_required') {
        setPreviewAuthRequired(true);
        setPreviewAuthenticated(false);
        setPreviewAuthError('This preview access code has expired or is no longer valid.');
      }
      return false;
    }
    try {
      setWorkspaces(await listWorkspaces());
      setWorkspacesLoaded(true);
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'preview_auth_required') {
        setPreviewAuthRequired(true);
        setPreviewAuthenticated(false);
        setPreviewAuthError('This preview access code has expired or is no longer valid.');
      }
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    if (previewAuthenticated) void refreshAgent();
  }, [previewAuthenticated, refreshAgent]);

  const handlePreviewUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = previewTokenInput.trim();
    if (!code || previewAuthBusy) return;
    setPreviewAuthBusy(true);
    setPreviewAuthError('');
    try {
      const response = await fetch('/api/preview-auth/check', {
        headers: { 'x-danav-preview-token': code },
        cache: 'no-store',
      });
      if (!response.ok) {
        setPreviewAuthError('That access code was not accepted. Try again.');
        return;
      }
      savePreviewAccessCode(code);
      setPreviewAuthenticated(true);
      setPreviewTokenInput('');
    } catch {
      setPreviewAuthError('Could not reach the preview backend. Try again in a moment.');
    } finally {
      setPreviewAuthBusy(false);
    }
  };

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
      showNotice(e?.message || 'Could not delete the workspace.');
      return;
    }
    await refreshAgent();
    setConversations((prev) => prev.map((c) => (c.agentWorkspaceId === id ? { ...c, agentWorkspaceId: null } : c)));
  };

  const handleToggleAutoRun = async (id: string, autoRun: boolean) => {
    try {
      await updateAgentWorkspace(id, { autoRun });
    } catch (e: any) {
      showNotice(e?.message || 'Could not change that setting.');
    }
    refreshAgent();
  };

  const handleAgentApproval = async (action: AgentAction, allow: boolean, always: boolean) => {
    if (!action.approval) throw new Error('This approval request is no longer available.');
    await answerApproval(action.approval.key, {
      allow,
      always,
      workspaceId: activeConversation?.agentWorkspaceId || undefined,
    });
    if (always) void refreshAgent();
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
    baseMessages?: Message[],
    /**
     * Resume a stopped agent turn IN PLACE: the id of the assistant message being
     * continued.
     *
     * Continuing used to be `handleSendMessage('Continue')` — a new user bubble, a
     * new assistant message, and the transcript looked like a second request. It is
     * the same run: the client keeps the existing message (blocks intact), streams
     * the new part into it, and the server's journal hands the model its plan and
     * the files it already changed. Nothing is retyped and nothing restarts.
     */
    resumeInto?: string,
    /** Explicit target for a safe retry after a provider-busy switch. */
    requestSelection?: { provider: Provider; modelId: string }
  ) => {
    const rawText = String(textToSend ?? '').trim();
    const currentAttachments = attachmentsToSend || [];

    const resumeSource = resumeInto
      ? (baseMessages || activeConversation?.messages || []).find((m) => m.id === resumeInto)
      : undefined;
    const isResume = Boolean(resumeSource && resumeInto);

    if (!isResume && !rawText && currentAttachments.length === 0) return;
    if (!activeConversation || isLoading) return;

    const requestProvider = requestSelection?.provider || activeProvider;
    const requestModelId = requestSelection?.modelId || activeModelId;
    const existingMessages = baseMessages || activeConversation.messages;

    /**
     * "continue", "carry on", "aage karo" — the user asking for the rest of the
     * work, not a new job. In agent mode that is a resume of the turn that stopped:
     * it carries on in the same message, with the same work line, and no bubble is
     * added for the word "continue".
     */
    if (!isResume && activeConversation.agentMode && isContinuationText(rawText)) {
      const lastAgentTurn = [...existingMessages].reverse().find((m) => m.role === 'assistant' && m.agent && !m.isGenerating);
      if (lastAgentTurn) {
        void handleSendMessage(undefined, undefined, webSearchEnabled, existingMessages, lastAgentTurn.id);
        return;
      }
    }

    if (!requestProvider) {
      showNotice('No provider is configured yet — open Settings → Providers & Models to add one.');
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

    const messageContent = isResume ? '' : rawText || (currentAttachments[0] ? `Attached file: ${currentAttachments[0].name}` : '');

    // User message
    const userMessage: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      role: 'user',
      content: messageContent,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      createdAt: Date.now(),
    };

    // Assistant placeholder (or, for a resume, the message that is being continued)
    const assistantMessageId = isResume ? String(resumeInto) : `msg-ai-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
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
    const shouldAutoName = !isResume && (isFirstUserMessage || !activeConversation.title || activeConversation.title === 'New Chat');
    const initialTitle = shouldAutoName
      ? generateTitleFromPrompt(messageContent)
      : activeConversation.title;

    if (shouldAutoName) {
      const convId = activeConversation.id;
      const titleEditRevision = titleEditRevisionRef.current.get(convId) || 0;
      generateAIChatTitle({
        provider: requestProvider,
        model: requestModelId,
        message: messageContent,
      }).then((aiTitle) => {
        // A slow title request must not replace a name the user has since chosen,
        // or an auto-title from a newer attempt.
        if (!aiTitle || (titleEditRevisionRef.current.get(convId) || 0) !== titleEditRevision) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId && c.title === initialTitle
              ? { ...c, title: aiTitle, updatedAt: Date.now() }
              : c
          )
        );
      });
    }

    /**
     * A resume touches exactly one message — the turn being continued — and adds
     * nothing: no user bubble, no second answer. Its blocks stay where they are and
     * the new ones are appended to them (see baseBlocks below).
     */
    const updatedMessages = isResume
      ? existingMessages.map((m) =>
          m.id === assistantMessageId
            ? { ...m, isGenerating: true, agentRun: undefined, agentStatus: undefined, error: undefined }
            : m
        )
      : [...existingMessages, userMessage, assistantMessage];

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

    if (!isResume) resetComposer();
    setIsLoading(true);

    // The web tools are handed to the MODEL, not run here. It decides what to
    // search for, which pages to open and when it has enough — the server
    // streams each tool it runs back as a `tool` event, and `upsertTool` records
    // it on the assistant message so the chat shows the research trail live.
    // Text files ride along inside the prompt. Images do NOT — they are sent
    // as real image parts (see buildMessageContent) so a vision model actually
    // sees them instead of a "[Attached Image: name]" placeholder.
    let attachmentsContext = '';
    const fileAttachments = currentAttachments.filter((att) => att.type !== 'image');
    if (fileAttachments.length > 0) {
      const parts = fileAttachments.map(
        (att) => `[Attached File: ${att.path || att.name}]\n\`\`\`\n${att.content || ''}\n\`\`\``
      );
      attachmentsContext = `[Attached Context from User]:\n${parts.join('\n\n')}\n[End of Attached Context]\n\n`;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    currentRunSelectionRef.current = {
      conversationId: activeConversation.id,
      assistantMessageId,
      providerId: requestProvider.id,
      modelId: requestModelId,
    };
    const isCurrentRun = () => abortControllerRef.current === controller;
    const clearCurrentRun = () => {
      if (!isCurrentRun()) return;
      abortControllerRef.current = null;
      currentRunSelectionRef.current = null;
      providerBusyRunRef.current = null;
      setIsLoading(false);
    };
    const restartWithPendingModel = (messages: Message[]): boolean => {
      const pending = pendingModelRetryRef.current;
      if (
        !pending ||
        pending.conversationId !== activeConversation.id ||
        pending.assistantMessageId !== assistantMessageId
      ) return false;
      pendingModelRetryRef.current = null;
      const initialSelection = { provider: pending.provider, modelId: pending.modelId };
      if (agentWorkspace) {
        // The client fetch aborts immediately, but the server still needs to unwind
        // its tool/model loop. Wait for its workspace lock to release before resume.
        // The task journal is keyed by this same message id, so committed work is
        // continued rather than replayed.
        const epoch = ++modelRetryEpochRef.current;
        const waitState = { conversationId: pending.conversationId, assistantMessageId: pending.assistantMessageId };
        modelRetryWaitRef.current = waitState;
        const switchingTo = initialSelection.provider.models.find((model) => model.id === initialSelection.modelId)?.name || initialSelection.modelId;
        setIsLoading(true);
        setConversations((prev) => prev.map((conversation) =>
          conversation.id !== waitState.conversationId
            ? conversation
            : {
                ...conversation,
                messages: conversation.messages.map((item) =>
                  item.id === waitState.assistantMessageId
                    ? { ...item, isGenerating: true, agentStatus: `Waiting for the previous workspace run to stop before retrying with ${switchingTo}…` }
                    : item
                ),
              }
        ));
        void (async () => {
          try {
            await stopAgentRun(agentWorkspace.id);
            if (modelRetryEpochRef.current !== epoch) return;
            modelRetryWaitRef.current = null;
            const latest = latestModelSelectionRef.current;
            const selection = latest.conversationId === pending.conversationId && latest.provider
              ? { provider: latest.provider, modelId: latest.modelId }
              : initialSelection;
            setIsLoading(false);
            void handleSendMessage(undefined, undefined, true, messages, assistantMessageId, selection);
          } catch (error) {
            if (modelRetryEpochRef.current !== epoch) return;
            modelRetryWaitRef.current = null;
            setIsLoading(false);
            const reason = error instanceof Error ? error.message : 'the server did not confirm that the previous run stopped';
            const message = `Could not safely resume on the new model: ${reason}. Retry when the workspace is ready.`;
            setConversations((prev) => prev.map((conversation) =>
              conversation.id !== pending.conversationId
                ? conversation
                : {
                    ...conversation,
                    messages: conversation.messages.map((item) =>
                      item.id === pending.assistantMessageId
                        ? { ...item, isGenerating: false, agentStatus: undefined, error: message }
                        : item
                    ),
                  }
            ));
            showNotice(message);
          }
        })();
      } else {
        // Regular chat has no mutating agent tools: retry the same user turn, not
        // the partial assistant output from the request that was interrupted.
        void handleSendMessage(messageContent, currentAttachments, webSearchEnabled, existingMessages, undefined, initialSelection);
      }
      return true;
    };

    const augmentedPrompt = `${attachmentsContext}${messageContent}`.trim();

    // Messages history to send. Each turn is rebuilt from what was stored, so
    // an image attached three turns ago is still sent with its own message.
    /**
     * What the model is shown as its own past work when a run is picked up.
     *
     * The transcript only ever carries text, so the actions of the stopped run —
     * every read, edit and command — would otherwise be invisible, and the model
     * would start the task over by re-analyzing everything. This puts them back in
     * its own message, in its own voice, with the note that they are already done.
     */
    const workSoFar = isResume
      ? (() => {
          const lines = collectActivity(resumeSource ? [resumeSource] : []);
          if (!lines.length) return '';
          return `\n\n[my work on this task so far — already done, not to be repeated:]\n${lines.join('\n')}`;
        })()
      : '';

    const historyPayload: Array<{ role: 'user' | 'assistant' | 'system'; content: ChatMessageContent }> = [
      ...existingMessages.map((m, i) => {
        const last = i === existingMessages.length - 1;
        const content = buildMessageContent(m.content, m.attachments);
        /**
         * The turn being continued gets its own actions appended, so the model sees
         * a single uninterrupted stretch of its own work instead of a gap where the
         * tool calls used to be.
         */
        if (isResume && last && m.id === assistantMessageId && workSoFar) {
          const text = typeof content === 'string' ? content : m.content;
          return { role: m.role as 'assistant', content: `${text}${workSoFar}` };
        }
        return {
          role: m.role === 'tool' ? ('user' as const) : (m.role as 'user' | 'assistant' | 'system'),
          content,
        };
      }),
      {
        role: 'user' as const,
        content: isResume ? RESUME_NOTE : buildMessageContent(augmentedPrompt, currentAttachments),
      },
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
      /**
       * A resume carries what the turn did so far: its blocks are the ones already
       * on screen (the new ones are appended to them), and its numbers are added to
       * the ones the run had, so the finished line reports the whole job rather
       * than just the second half of it.
       */
      const baseBlocks = isResume ? resumeSource?.blocks || [] : [];
      const previousRun = isResume ? resumeSource?.agentRun : undefined;
      const withBase = (incoming: MessageBlock[] = []) => (baseBlocks.length ? [...baseBlocks, ...incoming] : incoming);
      const mergeRun = (next: Message['agentRun']): Message['agentRun'] => {
        if (!previousRun) return next;
        if (!next) return previousRun;
        const changed = new Map((previousRun.changed || []).map((f) => [f.path, { ...f }]));
        for (const f of next.changed || []) {
          const was = changed.get(f.path);
          changed.set(f.path, was ? { ...was, added: was.added + f.added, removed: was.removed + f.removed } : { ...f });
        }
        return {
          stopReason: next.stopReason,
          // Never report less work than was actually done: two runs of 4 steps are 8.
          steps: (previousRun.steps || 0) + (next.steps || 0),
          toolCalls: (previousRun.toolCalls || 0) + (next.toolCalls || 0),
          durationMs: (previousRun.durationMs || 0) + (next.durationMs || 0),
          changed: [...changed.values()],
        };
      };
      const baseContent = isResume ? resumeSource?.content || '' : '';

      // Anything that can change a file on disk: the tool calls, or a command that does.
      const MUTATING = new Set(['write_file', 'edit_file', 'multi_edit', 'run_command']);
      let settledMutations = 0;
      /**
       * The docked preview follows the agent. Two things move it on: the agent
       * announcing a preview (`get_preview_url` finished — that IS the app, as of
       * now) and the agent changing files while a preview is on screen. Both go
       * through one ref, and both are no-ops when the panel is closed.
       */
      let announcedPreview = '';
      let previewStale = false;
      const followPreview = (url?: string, title?: string) => {
        previewStale = false;
        previewRefreshRef.current?.(url, title);
      };

      await runAgentTurn({
        provider: requestProvider,
        model: requestModelId,
        thinkingLevel: activeConversation.thinkingLevel,
        messages: historyPayload,
        workspaceId: agentWorkspace.id,
        taskId: assistantMessageId,
        activity: collectActivity(existingMessages),
        signal: controller.signal,
        resume: isResume,
        onStreamers: (text, thinking) => {
          if (!isCurrentRun()) return;
          contentStreamerRef.current = text;
          thinkingStreamerRef.current = thinking;
        },
        onUpdate: (snap, status) => {
          patchAssistant({
            content: snap.content || baseContent,
            thinkingContent: snap.thinkingContent,
            blocks: withBase(snap.blocks),
            agent: true,
            agentRun: mergeRun(snap.agentRun),
            agentStatus: status,
          });
          queueLatestSelectionAfterBusyStatus(convId, assistantMessageId, status);
          // keep an open Files panel live while the agent works
          const settled = snap.blocks.filter(
            (b) => b.type === 'action' && MUTATING.has(b.action.tool) && (b.action.status === 'done' || b.action.status === 'error')
          ).length;
          if (settled !== settledMutations) {
            settledMutations = settled;
            if (isCurrentRun()) setFilesRefresh((n) => n + 1);
            previewStale = true;
          }
          // A finished `get_preview_url` is the agent saying "the app is up" —
          // the panel should be showing that build, not the one before it. The
          // last one in the turn wins.
          let announcedUrl: string | undefined;
          let announcedTitle: string | undefined;
          for (const b of snap.blocks) {
            if (b.type !== 'action' || b.action.tool !== 'get_preview_url' || b.action.status !== 'done') continue;
            if (!b.action.result?.url) continue;
            announcedUrl = b.action.result.url;
            announcedTitle = b.action.result.title;
          }
          if (announcedUrl && announcedUrl !== announcedPreview) {
            announcedPreview = announcedUrl;
            if (isCurrentRun()) followPreview(announcedUrl, announcedTitle);
          }
        },
        onFinish: (snap, error) => {
          const finishedPatch: Partial<Message> = {
            content: snap.content || baseContent || (error ? 'Unable to complete the request.' : ''),
            thinkingContent: snap.thinkingContent,
            blocks: withBase(snap.blocks),
            agent: true,
            agentRun: mergeRun(snap.agentRun),
            agentStatus: undefined,
            isGenerating: false,
            ...(error ? { error } : {}),
          };
          patchAssistant(finishedPatch);
          const ownsRun = isCurrentRun();
          clearCurrentRun();
          if (ownsRun) setFilesRefresh((n) => n + 1);
          // The active turn changed files the open preview serves: show the result.
          if (ownsRun && previewStale) followPreview();
          if (ownsRun) {
            const completedMessages = updatedMessages.map((message) =>
              message.id === assistantMessageId ? { ...message, ...finishedPatch } : message
            );
            restartWithPendingModel(completedMessages);
          }
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
    const clearProviderBusyWindow = () => {
      const busy = providerBusyRunRef.current;
      if (busy?.conversationId === activeConversation.id && busy.assistantMessageId === assistantMessageId) {
        providerBusyRunRef.current = null;
      }
    };

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
                    agentStatus: undefined,
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
      provider: requestProvider,
      model: requestModelId,
      thinkingLevel: activeConversation.thinkingLevel,
      messages: historyPayload,
      toolsEnabled: Boolean(webSearchEnabled !== false),
      signal: controller.signal,
      onStatus: (status) => {
        if (!isCurrentRun() || controller.signal.aborted) return;
        setConversations((prev) => prev.map((conversation) =>
          conversation.id !== activeConversation.id
            ? conversation
            : {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === assistantMessageId
                    ? { ...message, agentStatus: status || undefined }
                    : message
                ),
              }
        ));
        queueLatestSelectionAfterBusyStatus(activeConversation.id, assistantMessageId, status);
      },
      onTool: (tool) => {
        clearProviderBusyWindow();
        upsertTool(tool);
      },
      onThinking: (chunk) => {
        clearProviderBusyWindow();
        thinkingStreamer.push(chunk);
      },
      onChunk: (chunk) => {
        clearProviderBusyWindow();
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
        const ownsRun = isCurrentRun();
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
                      agentStatus: undefined,
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
        clearCurrentRun();
        if (ownsRun) restartWithPendingModel(existingMessages);
      },
      onDone: () => {
        const ownsRun = isCurrentRun();
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
                      agentStatus: undefined,
                      blocks: finalBlocks,
                      ...(totalThinkingDurationSeconds ? { thinkingDuration: totalThinkingDurationSeconds } : {}),
                    }
                  : m
              ),
            };
          })
        );
        clearCurrentRun();
        if (ownsRun) restartWithPendingModel(existingMessages);
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
    const promptMessage = msgs[actualIndex];

    const trimmed = msgs.slice(0, actualIndex);
    // Keep the original files/images with the prompt being retried.
    await handleSendMessage(promptMessage.content, promptMessage.attachments, undefined, trimmed);
  };

  // Edit a past user message and regenerate response from that point
  const handleEditUserMessage = async (messageId: string, newContent: string) => {
    if (!activeConversation || isLoading) return;
    const msgs = activeConversation.messages;
    const msgIndex = msgs.findIndex((m) => m.id === messageId);
    if (msgIndex === -1) return;

    // Keep messages before this one, and keep the prompt's attached files/images.
    const trimmed = msgs.slice(0, msgIndex);
    await handleSendMessage(newContent, msgs[msgIndex].attachments, undefined, trimmed);
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

    await handleSendMessage(promptMsg.content, promptMsg.attachments, undefined, trimmed);
  };

  /**
   * Keep going from where the run stopped.
   *
   * The instruction is sent to the model as the turn's own note — it is in the
   * request, never in the transcript — and the answer streams back into the SAME
   * message: same blocks, same work line, one more stretch of work. That is what
   * makes it a resume rather than a second request.
   */
  const handleContinueResponse = (assistantMessageId?: string) => {
    if (assistantMessageId) {
      void handleSendMessage(undefined, undefined, true, undefined, assistantMessageId);
      return;
    }
    // Fallback for a plain (non-agent) answer: there is no run to resume, so the
    // old behaviour — ask for the rest of the answer — is the right one.
    void handleSendMessage('Continue');
  };

  const agentOn = Boolean(activeConversation?.agentMode);

  // ---- Sandbox status --------------------------------------------------------
  // The workspace chip has to tell the truth about the cloud sandbox, because the
  // SERVER pauses it on its own once it goes idle. Polling is cheap (one getInfo)
  // and is skipped entirely while the Sandboxes dialog is open, since that polls
  // the whole account by itself.
  const [sandboxStatusNonce, setSandboxStatusNonce] = useState(0);
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeWorkspaceKind = activeWorkspace?.kind ?? null;

  useEffect(() => {
    if (!agentOn || activeWorkspaceKind !== 'sandbox' || !activeWorkspaceId || sandboxesOpen) {
      setSandboxStatus(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const res = await getSandboxStatus(activeWorkspaceId);
        if (!cancelled) setSandboxStatus(res.status);
      } catch {
        /* the chip just stays blank; the run itself reports real errors */
      }
    };
    void read();
    const t = setInterval(read, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agentOn, activeWorkspaceId, activeWorkspaceKind, sandboxesOpen, sandboxStatusNonce, filesRefresh]);

  /** Closing the preview gives back the sidebar we took away for it. */
  const closePreview = useCallback(() => {
    setPreviewTarget(null);
    if (sidebarHiddenForPreviewRef.current) {
      sidebarHiddenForPreviewRef.current = false;
      setIsSidebarCollapsed(false);
    }
  }, []);

  // The right-hand column shows one thing at a time: the workspace files or the
  // running preview. Opening either closes the other.
  const toggleFiles = () => {
    setFilesOpen((open) => {
      if (!open) closePreview();
      return !open;
    });
  };

  /**
   * Open the preview. A paused sandbox answers nothing, so the panel goes up
   * straight away (with its loading state) and we wake the sandbox behind it;
   * once it is up the panel is told to load again.
   *
   * The sidebar is put away while the preview is open: on a laptop, 256px of
   * chat list is exactly the space the running app needs.
   *
   * Every open gets a NEW load token, including a re-open of the same URL. That
   * is the whole point: a preview URL stays the same while the app behind it is
   * rebuilt, and without a new token the frame had nothing to react to, so the
   * panel sat on the previous build forever while a new tab showed the new one.
   */
  const openPreview = useCallback(
    (url: string, title?: string) => {
      setFilesOpen(false);
      setPreviewTarget({ url, title, reloadKey: (previewTokenRef.current += 1) });
      setIsSidebarCollapsed((collapsed) => {
        if (!collapsed) sidebarHiddenForPreviewRef.current = true;
        return true;
      });
      if (activeWorkspaceKind !== 'sandbox' || !activeWorkspaceId) return;
      void (async () => {
        try {
          await wakeWorkspace(activeWorkspaceId);
          setSandboxStatusNonce((n) => n + 1);
          const token = (previewTokenRef.current += 1);
          setPreviewTarget((t) => (t && t.url === url ? { ...t, reloadKey: token } : t));
        } catch {
          /* the panel's own "still loading" hint covers this */
        }
      })();
    },
    [activeWorkspaceId, activeWorkspaceKind]
  );

  /**
   * The app the panel is showing has changed underneath it — a new preview URL,
   * or the same one after the agent rebuilt it. Point the panel at the new URL if
   * there is one, and make it load again either way.
   *
   * A closed panel stays closed: refreshing is not a reason to take over the
   * screen, and the token is only spent when there is a frame to spend it on.
   */
  const refreshPreview = useCallback((url?: string, title?: string) => {
    setPreviewTarget((t) => {
      if (!t) return t;
      const token = (previewTokenRef.current += 1);
      if (url && url !== t.url) return { url, title, reloadKey: token };
      return { ...t, reloadKey: token };
    });
  }, []);
  useEffect(() => {
    previewRefreshRef.current = refreshPreview;
  }, [refreshPreview]);

  const handlePreviewWidth = useCallback((width: number) => {
    setPreviewWidth(width);
    saveStoredPreviewWidth(width);
  }, []);

  // A narrower window must not leave the panel wider than the screen.
  useEffect(() => {
    const onResize = () => setPreviewWidth((w) => clampPreviewWidth(w, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---------------------------------------------------------------------------
  // One identity for everything the memoised chat and composer receive.
  //
  // Every token of a streaming answer re-renders this component. Anything passed
  // down as a fresh inline arrow makes React.memo on the other side useless: the
  // message list and the composer would rebuild on every token. The `...Stable`
  // wrappers below never change identity, and always call the newest handler.
  // ---------------------------------------------------------------------------
  const onToggleAgentStable = useStable(handleToggleAgent);
  const onSelectWorkspaceStable = useStable((id: string) => patchActive({ agentWorkspaceId: id }));
  const onCreateWorkspaceStable = useStable(() => setWorkspaceDialogOpen(true));
  const onDeleteWorkspaceStable = useStable(handleDeleteWorkspace);
  const onToggleAutoRunStable = useStable(handleToggleAutoRun);
  const onToggleFilesStable = useStable(toggleFiles);
  const onOpenSandboxesStable = useStable(() => setSandboxesOpen(true));

  const agentControlsNode = useMemo(
    () => (
      <AgentControls
        enabled={agentOn}
        onToggle={onToggleAgentStable}
        workspaces={workspaces}
        activeWorkspaceId={activeConversation?.agentWorkspaceId ?? null}
        onSelectWorkspace={onSelectWorkspaceStable}
        onCreate={onCreateWorkspaceStable}
        onDelete={onDeleteWorkspaceStable}
        onToggleAutoRun={onToggleAutoRunStable}
        filesOpen={filesOpen}
        onToggleFiles={onToggleFilesStable}
        onOpenSandboxes={onOpenSandboxesStable}
        sandboxState={sandboxStatus?.state ?? null}
        busy={isLoading}
      />
    ),
    // The stable callbacks are deliberately absent: they never change identity.
    [agentOn, workspaces, activeConversation?.agentWorkspaceId, filesOpen, sandboxStatus?.state, isLoading]
  );

  const onSendFromComposer = useStable((atts: Attachment[] | undefined, text: string) => {
    void handleSendMessage(text, atts, true);
  });
  const onStopStable = useStable(handleStop);
  const onSelectModelStable = useStable(handleSelectModel);
  const onSelectThinkingLevelStable = useStable(handleSelectThinkingLevel);

  const onRetryStable = useStable(() => void handleRetry());
  const onEditUserMessageStable = useStable((id: string, text: string) => void handleEditUserMessage(id, text));
  const onRegenerateResponseStable = useStable((id: string) => void handleRegenerateResponse(id));
  const onContinueResponseStable = useStable((id?: string) => handleContinueResponse(id));
  const onAgentApprovalStable = useStable((action: AgentAction, allow: boolean, always: boolean) =>
    handleAgentApproval(action, allow, always)
  );
  const onWatchMediaStable = useStable((id: string, type: string, title?: string) =>
    setActiveMoviePlayer({ isOpen: true, mediaId: id, mediaType: type, title: title || 'Now Playing' })
  );

  return (
    <div className="app-viewport relative flex w-screen overflow-hidden bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans">
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

        {/* Desktop: a collapsed sidebar is hidden completely, so this small
            icon is the only way back to it. */}
        {isSidebarCollapsed && (
          <div className="hidden lg:block absolute top-3 left-3 z-30">
            <button
              onClick={() => setIsSidebarCollapsed(false)}
              aria-label="Show sidebar"
              title="Show sidebar"
              data-testid="show-sidebar"
              className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <PanelLeft className="w-5 h-5 stroke-[1.75]" />
            </button>
          </div>
        )}

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
              draftResetKey={composerReset}
              onSend={onSendFromComposer}
              isLoading={isLoading}
              onStop={onStopStable}
              placeholder={agentOn ? 'Describe what to build or change…' : 'Ask anything...'}
              providers={providers}
              selectedProviderId={activeConversation?.selectedProviderId || providers[0]?.id}
              selectedModelId={activeModelId}
              thinkingLevel={activeConversation?.thinkingLevel || 'Auto'}
              onSelectModel={onSelectModelStable}
              onSelectThinkingLevel={onSelectThinkingLevelStable}
              agentControls={agentControlsNode}
            />
          </div>
        ) : (
          <div className="relative flex-1 flex flex-col h-full min-h-0 w-full overflow-hidden">
            {/* Chat Messages View with Far-Right Pinned Scrollbar */}
            <ChatArea
              messages={activeConversation.messages}
              isLoading={isLoading}
              onRetry={onRetryStable}
              onEditUserMessage={onEditUserMessageStable}
              onRegenerateResponse={onRegenerateResponseStable}
              onContinueResponse={onContinueResponseStable}
              onAgentApproval={onAgentApprovalStable}
              onOpenPreview={openPreview}
              agentMode={agentOn}
              sidebarCollapsed={isSidebarCollapsed}
              conversationId={activeConversation?.id}
              onWatchMedia={onWatchMediaStable}
            />

            {/* Floating Compact Chat Input at Bottom with subtle bottom fade */}
            <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none pt-10 safe-bottom px-4 bg-gradient-to-t from-white via-white/85 to-transparent dark:from-zinc-950 dark:via-zinc-950/85 dark:to-transparent">
              <div className="pointer-events-auto">
                <ChatInput
                  isCentered={false}
                  draftResetKey={composerReset}
                  onSend={onSendFromComposer}
                  isLoading={isLoading}
                  onStop={onStopStable}
                  placeholder={agentOn ? 'Describe what to build or change…' : 'Ask anything...'}
                  providers={providers}
                  selectedProviderId={activeConversation.selectedProviderId || providers[0]?.id}
                  selectedModelId={activeModelId}
                  thinkingLevel={activeConversation.thinkingLevel || 'Auto'}
                  onSelectModel={onSelectModelStable}
                  onSelectThinkingLevel={onSelectThinkingLevelStable}
                  agentControls={agentControlsNode}
                />
              </div>
            </div>
          </div>
        )}

        {/* In-page notice: the feedback that used to be an alert() */}
        {notice && (
          <div
            role="status"
            data-testid="app-notice"
            className="pointer-events-auto absolute left-1/2 top-3 z-40 -translate-x-1/2 max-w-[92vw] sm:max-w-md"
          >
            <div className="flex items-start gap-2 rounded-xl border border-amber-300/80 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/70 px-3.5 py-2.5 shadow-lg">
              <span className="text-xs text-amber-900 dark:text-amber-100 leading-relaxed">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                className="ml-1 shrink-0 rounded-md p-0.5 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Agent mode: browse the workspace the agent is working in */}
      {agentOn && filesOpen && activeWorkspace && (
        <WorkspacePanel key={activeWorkspace.id} workspace={activeWorkspace} refreshToken={filesRefresh} onClose={() => setFilesOpen(false)} />
      )}

      {/* The running app the agent built, docked on the right of the chat */}
      {previewTarget && (
        <PreviewPanel
          url={previewTarget.url}
          title={previewTarget.title}
          reloadKey={previewTarget.reloadKey}
          width={previewWidth}
          onWidthChange={handlePreviewWidth}
          onClose={closePreview}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        theme={theme}
        onThemeChange={handleThemeChange}
        providers={providers}
        onSaveProviders={handleSaveProviders}
        agentSummaryModel={agentSummaryModel}
        onSaveAgentSummaryModel={handleSaveAgentSummaryModel}
        conversations={conversations}
        onConversationsRestored={handleConversationsRestored}
      />

      {/* Agent mode: create a workspace (cloud sandbox or a folder on this machine) */}
      <WorkspaceDialog
        isOpen={workspaceDialogOpen}
        onClose={() => setWorkspaceDialogOpen(false)}
        config={agentConfig}
        onCreated={handleWorkspaceCreated}
        onConfigChanged={refreshAgent}
      />

      {/* Every sandbox in the Novita account — including ones no workspace owns */}
      <SandboxManagerDialog
        isOpen={sandboxesOpen}
        onClose={() => setSandboxesOpen(false)}
        config={agentConfig}
        onChanged={refreshAgent}
        busyWorkspaceId={isLoading ? activeConversation?.agentWorkspaceId ?? null : null}
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

      {previewAuthChecking ? (
        <div className="fixed inset-0 z-[200] grid place-items-center bg-zinc-950/80 p-4 text-sm text-zinc-200" role="status">Checking the private preview…</div>
      ) : previewAuthRequired && !previewAuthenticated ? (
        <div className="fixed inset-0 z-[200] grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="preview-auth-title">
          <form onSubmit={handlePreviewUnlock} className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-2xl">
            <div className="mb-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-300">Private sandbox</p>
              <h1 id="preview-auth-title" className="mt-2 text-xl font-semibold">Unlock Danav preview</h1>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Danav answers only to someone holding this code, so an open preview cannot spend your provider key or your Agent sandboxes.
              </p>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                It is printed where the server starts, and saved in <span className="font-mono">server/data/preview-token.txt</span>. Unlocking keeps it in this tab only.
              </p>
            </div>
            <label htmlFor="preview-access-code" className="mb-1.5 block text-xs font-medium text-zinc-300">Access code</label>
            <input
              id="preview-access-code"
              type="password"
              autoComplete="current-password"
              value={previewTokenInput}
              onChange={(event) => setPreviewTokenInput(event.target.value)}
              className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 font-mono text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
              placeholder="Paste the preview access code"
              autoFocus
            />
            {previewAuthError && <p className="mt-2 text-xs text-rose-300" role="alert">{previewAuthError}</p>}
            <button
              type="submit"
              disabled={previewAuthBusy || !previewTokenInput.trim()}
              className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewAuthBusy ? 'Checking…' : 'Continue to preview'}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
};
