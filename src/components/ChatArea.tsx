import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Sparkles, RotateCcw, ArrowDown } from 'lucide-react';
import { AgentAction, Message } from '../types';
import { ChatMessage } from './ChatMessage';

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  onRetry?: () => void;
  onSelectPromptSuggestion?: (text: string) => void;
  onEditUserMessage?: (messageId: string, newContent: string) => void;
  onRegenerateResponse?: (assistantMessageId: string) => void;
  onContinueResponse?: (assistantMessageId: string) => void;
  onWatchMedia?: (mediaId: string, mediaType: 'movie' | 'tv' | string, title?: string) => void;
  /** Agent mode: the user answered an "Allow this command?" prompt. */
  onAgentApproval?: (action: AgentAction, allow: boolean, always: boolean) => void;
  /** Show the running app the agent built in the docked preview panel. */
  onOpenPreview?: (url: string, title?: string) => void;
  /** Agent mode shows an extra controls row above the input, so leave more room below the messages. */
  agentMode?: boolean;
  /** The sidebar is hidden on desktop, so the reveal button floats over the chat. */
  sidebarCollapsed?: boolean;
}

const ChatAreaInner: React.FC<ChatAreaProps> = ({
  messages,
  isLoading,
  onRetry,
  onEditUserMessage,
  onRegenerateResponse,
  onContinueResponse,
  onWatchMedia,
  onAgentApproval,
  onOpenPreview,
  agentMode,
  sidebarCollapsed,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Following the bottom. Only the user can turn this off — see handleScroll. */
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  /** Scroll events before this moment are ours (we moved the container), not the user's. */
  const ignoreScrollUntilRef = useRef(0);
  const prevMessagesCountRef = useRef<number>(messages.length);

  const setPinnedBoth = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
  }, []);

  // Move the container ourselves, and remember that the scroll events which follow are ours.
  const scrollToBottom = useCallback(
    (smooth = false) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      ignoreScrollUntilRef.current = performance.now() + (smooth ? 700 : 120);
      if (smooth) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      setPinnedBoth(true);
    },
    [setPinnedBoth]
  );

  // The user is the only one who can stop the chat following: our own scrolls are ignored
  // above, so streaming can never be mistaken for someone scrolling up to read.
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (performance.now() < ignoreScrollUntilRef.current) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setPinnedBoth(distanceFromBottom <= 64);
  };

  // Sending a message always comes back to the bottom, even after reading back through history.
  useEffect(() => {
    if (messages.length > prevMessagesCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'user') {
        scrollToBottom(false);
      }
    }
    prevMessagesCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  /**
   * While an answer streams, follow it — but only while the user is still at the
   * bottom.
   *
   * This runs on every token, and `scrollHeight` forces the browser to lay the
   * whole chat out again. Asking for at most one scroll per animation frame keeps
   * the list pinned without doing the same work several times inside one frame.
   */
  const followFrameRef = useRef(0);
  useEffect(() => {
    if (!pinnedRef.current || followFrameRef.current) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      scrollToBottom(false);
    });
  }, [messages, scrollToBottom]);
  useEffect(() => () => cancelAnimationFrame(followFrameRef.current), []);

  const lastMessage = messages[messages.length - 1];
  const hasError = lastMessage?.role === 'assistant' && Boolean(lastMessage.error);

  return (
    <div className="relative flex-1 min-h-0 w-full overflow-hidden">
      {/* Outer scroll container: fills available height & width, scrollbar pinned to the far right edge of the screen */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto w-full"
      >
        {/*
          `chat-column` makes this box a container, so the prose inside can size
          itself from the width it is actually given rather than from the window
          — see the `.chat-column` rules in index.css.
        */}
        <div className={`chat-column max-w-3xl w-full mx-auto px-4 sm:px-6 space-y-2 ${sidebarCollapsed ? 'pt-14 lg:pt-6' : 'pt-6'} ${agentMode ? 'pb-40 sm:pb-44' : 'pb-28 sm:pb-32'}`}>
          {messages.length === 0 ? (
            // Clean Empty State
            <div className="min-h-[50vh] flex flex-col items-center justify-center text-center px-4 pt-12">
              <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 mb-4 border border-zinc-200/80 dark:border-zinc-700/60">
                <Sparkles className="w-5 h-5" />
              </div>
              <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
                How can I help you today?
              </h2>
              <p className="text-xs text-zinc-500 max-w-sm">
                Ask anything, write code, or explore ideas.
              </p>
            </div>
          ) : (
            // Messages Stream: User right-aligned, AI left-aligned
            <div className="space-y-3">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onEditUserMessage={onEditUserMessage}
                  onRegenerateResponse={onRegenerateResponse}
                  onContinueResponse={onContinueResponse}
                  onWatchMedia={onWatchMedia}
                  onAgentApproval={onAgentApproval}
                  onOpenPreview={onOpenPreview}
                />
              ))}

              {/* Inline Retry action if error */}
              {hasError && onRetry && (
                <div className="flex justify-start pt-1">
                  <button
                    onClick={onRetry}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Retry</span>
                  </button>
                </div>
              )}

              <div ref={bottomRef} className="h-2" />
            </div>
          )}
        </div>
      </div>

      {/* Floating "Scroll to Bottom" hover zone: Centered right above input box.
          Does not show automatically; becomes visible when mouse cursor moves over its zone */}
      {!pinned && (
        <div
          onClick={() => scrollToBottom(true)}
          className="group absolute bottom-20 sm:bottom-[88px] left-1/2 -translate-x-1/2 z-30 w-14 h-12 flex items-center justify-center cursor-pointer pointer-events-auto"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              scrollToBottom(true);
            }}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            className="flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white border border-zinc-200/90 dark:border-zinc-700 shadow-md hover:shadow-lg transition-all duration-200 cursor-pointer opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100"
          >
            <ArrowDown className="w-3.5 h-3.5 stroke-[2.2]" />
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Memoised: the props the app passes are stable, so the list only re-renders when
 * the message list itself changes — not when the sidebar, a dialog or the preview
 * panel updates.
 */
export const ChatArea = React.memo(ChatAreaInner);
ChatArea.displayName = 'ChatArea';
