import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Sparkles, RotateCcw, ArrowDown } from 'lucide-react';
import { Message } from '../types';
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
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isLoading,
  onRetry,
  onEditUserMessage,
  onRegenerateResponse,
  onContinueResponse,
  onWatchMedia,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isAutoScrollEnabledRef = useRef<boolean>(true);
  const prevMessagesCountRef = useRef<number>(messages.length);

  const lastScrollTopRef = useRef<number>(0);

  // Scroll to bottom helper using direct container scroll to avoid scrollIntoView glitches
  const scrollToBottom = useCallback((smooth = true) => {
    const container = scrollContainerRef.current;
    if (container) {
      if (smooth) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    }
    isAutoScrollEnabledRef.current = true;
    setShowScrollBottom(false);
  }, []);

  // Monitor user scrolling:
  // - Scrolling DOWN manually: immediately hide the scroll-to-bottom icon
  // - Scrolling UP: enable the scroll-to-bottom zone (revealed on hover)
  // - Near bottom: reset to auto-scroll
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const currentScrollTop = container.scrollTop;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    const isScrollingDown = currentScrollTop > lastScrollTopRef.current + 3;
    const isScrollingUp = currentScrollTop < lastScrollTopRef.current - 3;
    lastScrollTopRef.current = currentScrollTop;

    if (distanceFromBottom <= 50) {
      // Reached the bottom
      isAutoScrollEnabledRef.current = true;
      setShowScrollBottom(false);
    } else if (isScrollingDown) {
      // User is manually scrolling downwards: hide the button
      setShowScrollBottom(false);
    } else if (isScrollingUp && distanceFromBottom > 70) {
      // User is scrolling upwards to read history: make button available
      isAutoScrollEnabledRef.current = false;
      setShowScrollBottom(true);
    }
  };

  // When a new message is sent (especially user message), force auto-scroll to bottom
  useEffect(() => {
    if (messages.length > prevMessagesCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'user') {
        scrollToBottom(true);
      }
    }
    prevMessagesCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  // While AI is generating/streaming, only auto-scroll if user has NOT scrolled up
  useEffect(() => {
    if (isAutoScrollEnabledRef.current) {
      scrollToBottom(false);
    }
  }, [messages, scrollToBottom]);

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
        <div className="max-w-3xl w-full mx-auto px-4 sm:px-6 pt-6 pb-28 sm:pb-32 space-y-2">
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
      {showScrollBottom && (
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
