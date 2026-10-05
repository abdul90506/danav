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
  onAgentApproval?: (action: AgentAction, allow: boolean, always: boolean) => void | Promise<void>;
  /** Show the running app the agent built in the docked preview panel. */
  onOpenPreview?: (url: string, title?: string) => void;
  /** Agent mode shows an extra controls row above the input, so leave more room below the messages. */
  agentMode?: boolean;
  /** The sidebar is hidden on desktop, so the reveal button floats over the chat. */
  sidebarCollapsed?: boolean;
  /** Which conversation this is. Changing it means a different chat is on screen. */
  conversationId?: string | null;
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
  conversationId,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Following the bottom. Only the user can turn this off — see the handlers. */
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  /**
   * Where our own last scroll landed. A scroll event that arrives at (or below)
   * that position was caused by us, so it says nothing about what the user wants.
   */
  const ownScrollTopRef = useRef(-1);
  /** A smooth scroll animates; the events during it are ours too. */
  const smoothUntilRef = useRef(0);
  const lastTopRef = useRef(0);
  /** Finger position for touch scrolling: a drag down the screen means "scroll up". */
  const touchYRef = useRef<number | null>(null);
  const prevMessagesCountRef = useRef<number>(messages.length);

  // Re-rendering on every scroll event would be worse than the thing it fixes.
  const setPinnedBoth = useCallback((value: boolean) => {
    if (pinnedRef.current === value) return;
    pinnedRef.current = value;
    setPinned(value);
  }, []);

  // Move the container ourselves, and remember exactly where it landed.
  const scrollToBottom = useCallback(
    (smooth = false) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const top = container.scrollHeight - container.clientHeight;
      if (smooth) {
        smoothUntilRef.current = performance.now() + 700;
        container.scrollTo({ top, behavior: 'smooth' });
      } else {
        container.scrollTop = top;
      }
      ownScrollTopRef.current = top;
      lastTopRef.current = container.scrollTop;
      setPinnedBoth(true);
    },
    [setPinnedBoth]
  );

  const stopSmoothScroll = useCallback(() => {
    if (performance.now() >= smoothUntilRef.current) return;
    smoothUntilRef.current = 0;
    ownScrollTopRef.current = -1;
    const container = scrollContainerRef.current;
    if (container) container.scrollTo({ top: container.scrollTop, behavior: 'auto' });
  }, []);

  const pauseFollowing = useCallback(() => {
    const container = scrollContainerRef.current;
    const isSmooth = performance.now() < smoothUntilRef.current;
    const awayFromBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight > 1
      : false;
    // A wheel at the bottom of a short transcript cannot move anything. Let the
    // resulting scroll event decide whether following should pause; only force it
    // here when there is room to scroll or an animation needs to be interrupted.
    if (!isSmooth && !awayFromBottom) return;
    setPinnedBoth(false);
    stopSmoothScroll();
  }, [setPinnedBoth, stopSmoothScroll]);

  /**
   * The user is the only one who can stop the chat following.
   *
   * The intent comes from the device, not from guessing: a wheel turned up, a
   * finger dragged down, or Page Up means "hold still". Pausing also interrupts a
   * smooth jump already in flight, so it cannot keep pulling the transcript away
   * after the user starts reading above it.
   */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pauseFollowing();
  };
  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined || touchYRef.current === null) return;
    if (y > touchYRef.current + 4) pauseFollowing(); // finger down the screen = content up
    touchYRef.current = y;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') pauseFollowing();
  };

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const top = container.scrollTop;
    if (performance.now() < smoothUntilRef.current) {
      const userMovedUp = top < lastTopRef.current - 6;
      lastTopRef.current = top;
      // A scrollbar drag has no wheel/touch/key event to announce intent. During
      // a smooth return-to-latest, an upward delta is the reliable signal.
      if (userMovedUp) {
        smoothUntilRef.current = 0;
        ownScrollTopRef.current = -1;
        setPinnedBoth(false);
        container.scrollTo({ top, behavior: 'auto' });
      }
      return;
    }
    if (ownScrollTopRef.current >= 0 && top >= ownScrollTopRef.current - 2) {
      ownScrollTopRef.current = -1;
      lastTopRef.current = top;
      return;
    }
    ownScrollTopRef.current = -1;
    const distanceFromBottom = container.scrollHeight - top - container.clientHeight;
    const wentUp = top < lastTopRef.current - 6;
    lastTopRef.current = top;
    setPinnedBoth(wentUp ? false : distanceFromBottom <= 48);
  };

  /**
   * Following, at most once per frame.
   *
   * `scrollHeight` forces the browser to lay the whole chat out again, so asking
   * for one scroll per animation frame keeps the list pinned without doing the
   * same work several times inside a frame — and it is the single path every
   * "follow the newest" call goes through, so the send-scroll and the stream
   * follow can never fight each other.
   */
  const followFrameRef = useRef(0);
  const follow = useCallback(() => {
    if (!pinnedRef.current || followFrameRef.current) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      scrollToBottom(false);
    });
  }, [scrollToBottom]);
  useEffect(() => () => cancelAnimationFrame(followFrameRef.current), []);

  // While an answer streams and the user has not scrolled away, stay at the bottom.
  useEffect(() => {
    follow();
  }, [messages, follow]);

  /**
   * Opening another chat starts at its newest message.
   *
   * Without this, "paused" carried over from the previous conversation: you scroll
   * up in one chat, switch, and the new one opens somewhere in the middle of its
   * history with the newest answer out of sight. A conversation switch is not a
   * scroll, so it resets the follow.
   */
  useEffect(() => {
    scrollToBottom(false);
    const frame = requestAnimationFrame(() => scrollToBottom(false));
    return () => cancelAnimationFrame(frame);
  }, [conversationId, scrollToBottom]);

  /**
   * Anything that changes the height of the transcript after the fact — an image
   * loading, an action row expanding, the composer's own spacer — has to keep the
   * chat pinned too. A ResizeObserver catches all of them in one place, instead of
   * every component remembering to ask for a scroll.
   */
  useEffect(() => {
    const column = scrollContainerRef.current?.firstElementChild;
    if (!column || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => follow());
    observer.observe(column);
    return () => observer.disconnect();
  }, [follow]);

  /**
   * Sending always comes back to the bottom — including from far up the history,
   * and including the case where the new message has not been laid out yet: the
   * box is scrolled once now and once after the browser has painted, so the answer
   * that follows starts from the bottom rather than from the old height.
   */
  useEffect(() => {
    if (messages.length > prevMessagesCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'user') {
        scrollToBottom(false);
        const frame = requestAnimationFrame(() => scrollToBottom(false));
        prevMessagesCountRef.current = messages.length;
        return () => cancelAnimationFrame(frame);
      }
    }
    prevMessagesCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);


  const lastMessage = messages[messages.length - 1];
  const hasError = lastMessage?.role === 'assistant' && Boolean(lastMessage.error);

  return (
    <div className="relative flex-1 min-h-0 w-full overflow-hidden">
      {/* Outer scroll container: fills available height & width, scrollbar pinned to the far right edge of the screen */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        aria-busy={isLoading}
        className="h-full overflow-y-auto w-full focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400/60"
      >
        {/*
          `chat-column` makes this box a container, so the prose inside can size
          itself from the width it is actually given rather than from the window
          — see the `.chat-column` rules in index.css.
        */}
        <div
          className={`chat-column max-w-3xl w-full mx-auto px-4 sm:px-6 space-y-2 ${sidebarCollapsed ? 'pt-14 lg:pt-6' : 'pt-6'} ${agentMode ? 'pb-40 sm:pb-44' : 'pb-28 sm:pb-32'}`}
        >
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
            // Messages Stream: User right-aligned, AI left-aligned.
            // The rhythm between turns is set here, in one place — ChatMessage no
            // longer adds a margin of its own.
            <div className="space-y-5">
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

              {/*
                The composer floats over the transcript, and a long draft makes it
                taller — far enough that its top would cover the last lines of the
                answer. It publishes how much extra room it needs as a CSS variable
                (no re-render, no measurement loop), and this spacer clears it.
              */}
              <div style={{ height: 'var(--danav-composer-extra, 0px)' }} aria-hidden="true" />
              <div ref={bottomRef} className="h-2" />
            </div>
          )}
        </div>
      </div>

      {/* Return to the newest message after the user pauses auto-follow. */}
      {!pinned && (
        <div className="chat-scroll-latest absolute left-1/2 z-30 flex -translate-x-1/2 items-center justify-center pointer-events-none">
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            title="Back to the latest"
            aria-label="Scroll to the latest message"
            className="flex items-center justify-center w-10 h-10 rounded-full bg-white/95 dark:bg-zinc-800/95 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white border border-zinc-200/90 dark:border-zinc-700 shadow-md hover:shadow-lg transition-all duration-200 cursor-pointer pointer-events-auto"
          >
            <ArrowDown className="w-4 h-4 stroke-[2.2]" />
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
