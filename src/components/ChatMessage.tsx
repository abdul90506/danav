import React, { useState, useRef, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Brain, ChevronDown, ChevronRight, Pencil, RotateCcw, Play, File, Folder, ExternalLink, PanelRight } from 'lucide-react';
import { AgentAction, Message, MessageBlock, MovieItem } from '../types';
import { CodeBlock } from './CodeBlock';
import { ToolExecutionCard } from './ToolExecutionCard';
import { MovieCard } from './MovieCard';
import { copyText } from '../utils/clipboard.ts';
import { normalizeMessageContent } from '../utils/markdownNormalize';
import { isPreviewUrl, previewHost } from '../utils/previewUrl';
import { AgentActionRow } from './AgentActionRow';
import { getOpenThinkingId, setOpenThinkingId, subscribeThinkingAccordion } from './thinkingAccordion';
import { stopNotice, workedSummary } from '../agent/format';
import { useDismissOnOutside, useEscapeToClose } from '../utils/useDismissOnOutside';
import { createPanelStore, usePanelOpen } from './panels';
import { AgentTrail } from './AgentTrailGroup';
import { useThrottledValue } from '../utils/throttledValue';
import { useElapsedSeconds } from '../utils/useElapsedSeconds';

/** One work row open at a time, chat-wide — the same rule as every other panel. */
const workStore = createPanelStore();

/**
 * The one line a turn ends with: what it did, and everything it did behind it.
 *
 * A run reads as a dozen rows — reads, edits, commands, searches, notes to
 * memory — and a transcript of them is a wall. They all live in here instead: the
 * line says the turn's own numbers ("Worked for 32s · 8 actions · 2 files +7 −1")
 * and opening it shows the whole run in the order it happened, thoughts included,
 * in the place each one happened. Nothing is lost — it is one click instead of a
 * screenful.
 *
 * While the run is still going the same line is the live one ("Working… 12s",
 * "Thinking… 12s"), so the trail can be watched as it is written.
 */
const AgentWorkRow: React.FC<{
  messageId: string;
  live: boolean;
  liveLabel: string;
  elapsedSeconds: number;
  /** The finished numbers, once the run is over. */
  summary?: string;
  notice?: string;
  children: React.ReactNode;
}> = ({ messageId, live, liveLabel, elapsedSeconds, summary, notice, children }) => {
  const id = `work-${messageId}`;
  const open = usePanelOpen(workStore, id);
  const close = React.useCallback(() => workStore.close(), []);
  /**
   * Once opened, the trail stays open: reading it and clicking somewhere else is
   * not the same as dismissing a menu. Escape still puts it away (and, being
   * registered, that Escape does not also stop a run that is still working).
   */
  useEscapeToClose(close, open);

  const toggle = () => (workStore.get() === id ? workStore.close() : workStore.set(id));

  return (
    <div className="mt-1 select-none">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? 'Hide what this turn did' : 'Show what this turn did'}
        className="group/work flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 max-w-full text-left cursor-pointer py-1 -my-0.5 rounded-sm"
      >
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 self-center text-zinc-400 dark:text-zinc-500 transition-transform duration-200 group-hover/work:text-zinc-700 dark:group-hover/work:text-zinc-200 ${
            open ? 'rotate-90' : ''
          }`}
        />
        {live ? (
          <span className="agent-shimmer text-[14px] leading-6">{liveLabel}</span>
        ) : (
          /*
            The turn's own numbers, one size up from the small print: this is the
            line a finished turn is read by, so it gets room to breathe and wraps
            at the separators on a narrow screen instead of being cut off.
          */
          <span className="text-[14px] leading-6 font-medium text-zinc-600 dark:text-zinc-300 group-hover/work:text-zinc-900 dark:group-hover/work:text-zinc-100 transition-colors">
            {summary}
            {summary && notice ? <span className="font-normal text-zinc-400 dark:text-zinc-500"> · </span> : null}
            {notice ? <span className="font-normal text-zinc-500 dark:text-zinc-400">{notice}</span> : null}
          </span>
        )}
        {live && elapsedSeconds >= 2 && (
          <span className="text-[13px] text-zinc-400 dark:text-zinc-500">{elapsedSeconds}s</span>
        )}
      </button>

      {/*
        Kept mounted and hidden rather than unmounted: the rows inside keep their
        state (an opened diff stays opened), and a trail that is opened mid-run is
        already up to date instead of rebuilding itself from the start.
      */}
      <div hidden={!open} className="mt-2 ml-1 pl-3.5 border-l border-zinc-200 dark:border-zinc-800">
        {children}
      </div>
    </div>
  );
};

interface ChatMessageProps {
  message: Message;
  onEditUserMessage?: (messageId: string, newContent: string) => void;
  onRegenerateResponse?: (assistantMessageId: string) => void;
  onContinueResponse?: (assistantMessageId: string) => void;
  onWatchMedia?: (mediaId: string, mediaType: 'movie' | 'tv' | string, title?: string) => void;
  /** Agent mode: the user answered an "Allow this command?" prompt. */
  onAgentApproval?: (action: AgentAction, allow: boolean, always: boolean) => void;
  /** Show the running app the agent built in the docked preview panel. */
  onOpenPreview?: (url: string, title?: string) => void;
}

/**
 * Decide whether a fenced block is really prose the model wrapped in a fence,
 * or actual code.
 *
 * The previous heuristic flagged any block containing words like "file",
 * "create" or "update" as prose — which meant real code blocks were rendered as
 * a wall of plain text. We now require the block to contain no code syntax at
 * all before treating it as prose.
 */
const looksLikeProse = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  if (/[{}<>;=]|=>|::|->|\$\(|\w+\([^)]*\)\s*\{/.test(text)) return false;
  if (/^\s*(?:[-*+]|\d+\.)\s+/m.test(text)) return true;
  if (/^\s*#{1,6}\s+/m.test(text)) return true;
  const sentences = text.split(/[.!?]\s+/).filter((part) => part.trim().length > 12);
  return sentences.length >= 2;
};

/**
 * One markdown block, parsed at most thirty times a second while it is the live
 * one. In an agent transcript the answer can be many blocks long, and only the
 * block still being written is re-parsed on every frame; the finished ones are
 * parsed once when they arrive.
 */
const MarkdownBlock: React.FC<{ content: string; streaming?: boolean; components: any }> = ({ content, streaming, components }) => {
  const shown = useThrottledValue(content, 32, Boolean(streaming));
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(uri) => uri}>
      {shown}
    </ReactMarkdown>
  );
};

interface ThinkingSectionProps {
  /** Stable id for the accordion: only one thinking block is open in the whole chat. */
  id: string;
  thinkingContent: string;
  isStillThinking: boolean;
  thinkingDuration?: number;
  /** How many reasoning rounds this turn had, when more than one. */
  rounds?: number;
}

/**
 * One small row for the whole turn's reasoning.
 *
 * The model reasons in several rounds between tool calls, and each round used to
 * render its own "Thought for 5s" row: a long run turned into a column of them,
 * each one saying almost nothing. What the user wants to see is one quiet line
 * that says the turn thought for a while, and the detail behind it if they ask.
 * The rows are merged here: the durations add up, the rounds are kept in order
 * inside one box, and only one of these is ever open in the whole chat.
 */
/**
 * The turn's reasoning inside the work trail: one small entry, in the place the
 * thinking actually happened.
 *
 * The rounds are merged exactly as before — durations added up, every round kept
 * in order in one block — but the entry is not lifted above the turn any more,
 * and it needs no disclosure of its own: by the time it can be read, the trail it
 * lives in is already open.
 */
const ThinkingEntry: React.FC<{
  content: string;
  duration?: number;
  rounds?: number;
  /** A round is streaming right now. */
  active?: boolean;
}> = ({ content, duration, rounds, active }) => (
  <div className="my-1.5">
    <div className="flex items-center gap-1.5 text-[12px] select-none">
      <Brain className={`w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-zinc-400 ${active ? 'thinking-brain-shimmer' : ''}`} />
      {active ? (
        <span className="thinking-shimmer tracking-wide">Thinking…</span>
      ) : (
        <span className="tracking-wide text-zinc-500 dark:text-zinc-400">
          Thought for {duration || 1}s
          {rounds && rounds > 1 ? <span className="text-zinc-400 dark:text-zinc-500"> · {rounds} rounds</span> : null}
        </span>
      )}
    </div>
    {content.trim() ? (
      <div className="panel-scroll mt-1 max-h-56 overflow-y-auto overscroll-y-contain pl-3 py-0.5 border-l border-zinc-200 dark:border-zinc-800 text-[13px] leading-[1.65] text-zinc-500 dark:text-zinc-400 font-sans whitespace-pre-wrap select-text">
        {content}
      </div>
    ) : null}
  </div>
);

const ThinkingSection: React.FC<ThinkingSectionProps> = ({
  id,
  thinkingContent,
  isStillThinking,
  thinkingDuration,
  rounds,
}) => {
  // One thought open at a time, chat-wide: opening this one closes the others.
  // The third argument is the server snapshot — without it React refuses to
  // render this anywhere that is not a live browser (the test renderer, and any
  // pre-render), which is exactly the bug the first audit run turned up.
  const openId = useSyncExternalStore(subscribeThinkingAccordion, getOpenThinkingId, () => null);
  const isExpanded = openId === id;

  const rootRef = useRef<HTMLDivElement>(null);
  const thinkBoxRef = useRef<HTMLDivElement>(null);
  /** The user scrolled this box themselves: stop following until they come back down. */
  const pausedRef = useRef(false);
  /** Scroll events before this moment are ours, not the user's. */
  const ignoreScrollUntilRef = useRef(0);
  // Nothing here reveals itself. “Thinking…” is on the row the whole time a round is
  // being written, and the box is opened by the user, not by the model: reading the
  // reasoning is a choice, and a turn that thinks three times should not push three
  // boxes in front of the answer.
  /**
   * Seconds from the round being written right now — added to the rounds already
   * finished, so a turn that reasons three times shows one growing number rather
   * than a number that stands still between rounds.
   */
  const [liveSeconds, setLiveSeconds] = useState(0);
  React.useEffect(() => {
    if (!isStillThinking) {
      setLiveSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setLiveSeconds(Math.max(0, Math.round((Date.now() - started) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [isStillThinking]);

  // Follow the newest reasoning — inside this box only, so the chat around it never moves.
  // The scroll is INSTANT on purpose: a smooth one fires a stream of scroll events that
  // look exactly like a user scrolling away, and the follow switched itself off.
  React.useEffect(() => {
    if (!isExpanded || !isStillThinking || pausedRef.current) return;
    const el = thinkBoxRef.current;
    if (!el) return;
    ignoreScrollUntilRef.current = performance.now() + 150;
    el.scrollTop = el.scrollHeight;
  }, [thinkingContent, isExpanded, isStillThinking]);

  // Pause the follow when the user scrolls up or grabs the scrollbar; resume at the bottom.
  const handleThinkBoxScroll = () => {
    const el = thinkBoxRef.current;
    if (!el) return;
    if (performance.now() < ignoreScrollUntilRef.current) return; // that one was ours
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pausedRef.current = distanceFromBottom > 24;
  };

  const toggle = () => (isExpanded ? setOpenThinkingId(null) : setOpenThinkingId(id));

  /**
   * Clicking anywhere else — or Escape — puts the reasoning away. It used to be the
   * one revealed thing in the chat that ignored this, so an opened thought stayed
   * open over everything until it was clicked again or another panel took its place.
   */
  useDismissOnOutside(rootRef, isExpanded, () => setOpenThinkingId(null));

  // While reasoning streams, render it line by line so each new line can fade
  // in (see `.stream-lines` in index.css). Long blocks fall back to one text
  // node — the fade is a nicety, not worth a thousand spans per frame.
  const streamLines = React.useMemo(() => {
    if (!isStillThinking) return null;
    const lines = thinkingContent.split('\n');
    return lines.length <= 400 ? lines : null;
  }, [thinkingContent, isStillThinking]);

  const durationSec = (thinkingDuration || 0) + (isStillThinking ? liveSeconds : 0) || 1;

  return (
    <div ref={rootRef} className="mb-3.5 select-none">
      {/* Clean inline header: Brain icon on left, text in the middle, chevron on the right. No stat box! */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        className="inline-flex items-center gap-1.5 py-1 text-xs font-semibold cursor-pointer select-none group/think transition-colors"
      >
        <Brain
          className={`w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-zinc-400 ${
            isStillThinking
              ? 'thinking-brain-shimmer'
              : 'group-hover/think:text-zinc-700 dark:group-hover/think:text-zinc-200'
          }`}
        />
        {isStillThinking ? (
          <span className="thinking-shimmer text-xs tracking-wide">Thinking…</span>
        ) : (
          <span className="text-xs tracking-wide text-zinc-500 dark:text-zinc-400 group-hover/think:text-zinc-800 dark:group-hover/think:text-zinc-200 transition-colors">
            Thought for {durationSec}s
            {rounds && rounds > 1 ? <span className="text-zinc-400 dark:text-zinc-500"> · {rounds} rounds</span> : null}
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 dark:text-zinc-500 group-hover/think:text-zinc-700 dark:group-hover/think:text-zinc-200 transition-transform duration-200 shrink-0 ${
            isExpanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </button>

      {/* The reasoning, in a small box of its own — quiet, plain, and never taller
          than a short paragraph, so reading it stays optional. */}
      {isExpanded && (
        <div className="relative mt-1 animate-in fade-in duration-150">
          <div
            ref={thinkBoxRef}
            onScroll={handleThinkBoxScroll}
            className="panel-scroll max-h-56 overflow-y-auto overscroll-y-contain pl-3 py-0.5 border-l border-zinc-200 dark:border-zinc-800 text-[13px] leading-[1.65] text-zinc-500 dark:text-zinc-400 font-sans whitespace-pre-wrap select-text"
          >
            {streamLines && !isStillThinking ? (
              <span className="stream-lines">
                {streamLines.map((line, i) => (
                  <span key={i} className="stream-line block">
                    {line || '\u00A0'}
                  </span>
                ))}
              </span>
            ) : (
              thinkingContent
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const getMessageBlocks = (message: Message): MessageBlock[] => {
  if (message.blocks && message.blocks.length > 0) {
    return message.blocks;
  }
  const list: MessageBlock[] = [];
  if (message.thinkingContent) {
    list.push({
      id: 'legacy-think',
      type: 'thinking',
      content: message.thinkingContent,
      duration: message.thinkingDuration,
    });
  }
  if (message.toolExecutions && message.toolExecutions.length > 0) {
    for (const tool of message.toolExecutions) {
      list.push({
        id: tool.id,
        type: 'tool',
        tool,
      });
    }
  }
  return list;
};

const ChatMessageInner: React.FC<ChatMessageProps> = ({
  message,
  onEditUserMessage,
  onRegenerateResponse,
  onContinueResponse,
  onWatchMedia,
  onAgentApproval,
  onOpenPreview,
}) => {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const isUser = message.role === 'user';

  // Keep legacy Thinking box open ONLY while still generating AND no text response has arrived yet
  const isStillThinking = Boolean(
    message.thinkingContent && !message.error && message.isGenerating && !message.content
  );

  const safeMessageContent = normalizeMessageContent(message.content || '');
  /**
   * While the answer streams, the text arrives once per animation frame. Markdown
   * is parsed from the WHOLE message every time it changes, so a long answer would
   * be re-parsed sixty times a second, each time on more text. Reading it thirty
   * times a second looks identical and costs half as much; when the stream stops,
   * the final text is rendered at once. `message.content` itself is untouched, so
   * copying the answer always copies all of it.
   */
  const streamedContent = useThrottledValue(safeMessageContent, 32, Boolean(message.isGenerating));
  const blocks = getMessageBlocks(message);
  // An agent turn is a chronological list of narration + actions; it renders as one timeline.
  const isAgentTimeline = Boolean(message.agent) || blocks.some((b) => b.type === 'text' || b.type === 'action');

  // The trailing text block of a live turn is the one still being written, so
  // only it gets the fade-in + caret; everything before it stays perfectly still.
  const trailingBlock = blocks[blocks.length - 1];
  const liveTextId =
    message.isGenerating &&
    !message.error &&
    trailingBlock &&
    trailingBlock.type === 'text' &&
    !trailingBlock.notice
      ? trailingBlock.id
      : null;

  const handleCopyMessage = async () => {
    if (await copyText(safeMessageContent)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSaveEdit = () => {
    if (editText.trim() && onEditUserMessage) {
      onEditUserMessage(message.id, editText.trim());
      setIsEditing(false);
    }
  };

  if (isUser) {
    if (isEditing) {
      return (
        <div className="flex justify-end w-full mb-4">
          <div className="w-full max-w-[85%] sm:max-w-[75%] rounded-2xl p-3 bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-700 shadow-sm animate-in fade-in duration-150">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveEdit();
                }
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  setEditText(message.content);
                }
              }}
              rows={Math.min(6, Math.max(2, editText.split('\n').length))}
              className="w-full bg-transparent text-[14.5px] leading-relaxed text-zinc-900 dark:text-zinc-100 focus:outline-none resize-none font-sans"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-zinc-200/60 dark:border-zinc-700/60">
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setEditText(message.content);
                }}
                className="px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!editText.trim() || editText.trim() === message.content}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end w-full group mb-4">
        {/* Attached files/folders if present */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-[85%] sm:max-w-[75%]">
            {message.attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-200/70 dark:border-zinc-700/60 text-xs text-zinc-700 dark:text-zinc-200"
              >
                {att.previewUrl || (att.type === 'image' && att.content) ? (
                  <img
                    src={att.previewUrl || att.content}
                    alt=""
                    className="w-4 h-4 rounded object-cover"
                  />
                ) : att.type === 'folder' ? (
                  <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                ) : (
                  <File className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                )}
                <span className="font-mono text-[11px] truncate max-w-[140px]">
                  {att.name}
                </span>
                <span className="text-[10px] text-zinc-400">
                  {Math.round(att.size / 1024) || 1}KB
                </span>
              </div>
            ))}
          </div>
        )}

        {/* User message bubble: strictly hugs text size. `chat-prose` tracks the
            same `--chat-font` as the answers, so both sides of the chat shrink
            together when the preview docks and takes the width. */}
        <div className="chat-prose inline-block max-w-[85%] sm:max-w-[75%] rounded-2xl sm:rounded-3xl px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 break-words whitespace-pre-wrap select-text font-sans">
          {message.content}
        </div>

        {/* Action icons at the corner (nukar) below user message on hover */}
        <div className="flex items-center gap-0.5 mt-1 mr-1.5 opacity-0 group-hover:opacity-100 touch-reveal focus-within:opacity-100 transition-opacity">
          {onEditUserMessage && (
            <button
              onClick={() => {
                setEditText(message.content);
                setIsEditing(true);
              }}
              title="Edit prompt"
              aria-label="Edit prompt"
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5 stroke-[1.75]" />
            </button>
          )}
          <button
            onClick={handleCopyMessage}
            title="Copy message"
            aria-label="Copy message"
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5 stroke-[1.75]" />
            )}
          </button>
        </div>
      </div>
    );
  }

  const markdownComponents = {
    code({ node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children).replace(/\n$/, '');
      const isInline = !className && !String(children).includes('\n');

      if (!isInline) {
        // Only an un-tagged fence with zero code syntax is treated as prose.
        const isMarkdownText = !match && looksLikeProse(codeString);

        if (isMarkdownText) {
          return (
            <div className="my-2.5 text-[14.5px] leading-relaxed text-zinc-800 dark:text-zinc-200 font-sans whitespace-pre-wrap select-text">
              {codeString}
            </div>
          );
        }

        return (
          <CodeBlock
            language={match ? match[1] : 'text'}
            value={codeString}
          />
        );
      }

      return (
        <code
          className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-[13px] text-zinc-800 dark:text-zinc-200 border border-zinc-200/70 dark:border-zinc-700/60"
          {...props}
        >
          {children}
        </code>
      );
    },
    a({ node, children, href, ...props }: any) {
      const lowerHref = String(href || '').toLowerCase();
      const textContent = (Array.isArray(children) ? children.join('') : String(children || '')).trim();
      const isWatchText = /watch\s*now/i.test(textContent);

      const isWatchLink =
        lowerHref.startsWith('watch://') ||
        lowerHref.includes('watch.php') ||
        lowerHref.includes('movie.php') ||
        lowerHref.includes('tv-show.php') ||
        lowerHref.includes('flixraid') ||
        (isWatchText && (lowerHref.includes('movie') || lowerHref.includes('tv') || !href || href === '#' || href === ''));

      if (isWatchLink || isWatchText) {
        // If this message already contains a movie poster image, the MovieCard is already displayed with its own Watch Now button!
        const hasPosterImage = Boolean(
          message.content &&
          (message.content.includes('themoviedb.org') ||
           message.content.includes('tmdb.org') ||
           message.content.includes('/w500/') ||
           message.content.includes('/t/p/'))
        );

        if (hasPosterImage) {
          return null;
        }

        let mediaType = 'movie';
        let mediaId = '';

        if (lowerHref.startsWith('watch://')) {
          const parts = href.replace(/watch:\/\//i, '').split('/');
          mediaType = parts[0] || 'movie';
          mediaId = parts[1] || '';
        } else if (href && (href.startsWith('http') || href.includes('?id='))) {
          try {
            const urlObj = new URL(href, 'http://localhost');
            mediaId = urlObj.searchParams.get('id') || '';
            if (urlObj.searchParams.get('type') === 'tv' || lowerHref.includes('tv-show') || lowerHref.includes('/tv/')) {
              mediaType = 'tv';
            }
          } catch (e) {
            const idMatch = href.match(/id=([0-9]+)/i);
            if (idMatch) mediaId = idMatch[1];
          }
        }

        // If mediaId was in the node or data attributes or fallback
        if (!mediaId && node?.properties?.href) {
          const raw = String(node.properties.href);
          const m = raw.match(/([0-9]{3,})/);
          if (m) mediaId = m[1];
        }

        if (onWatchMedia) {
          return (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (mediaId) {
                  onWatchMedia(mediaId, mediaType, textContent || 'Now Playing');
                } else {
                  // Fallback: look for ID in tool blocks
                  const toolBlock = message.blocks?.find(
                    (b): b is Extract<typeof b, { type: 'tool' }> =>
                      b.type === 'tool' && Boolean(b.tool.movies?.length)
                  );
                  const firstMovie = toolBlock?.tool.movies?.[0];
                  if (firstMovie) {
                    onWatchMedia(firstMovie.id, firstMovie.media_type, firstMovie.title);
                  }
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 my-1.5 rounded-xl bg-red-600 hover:bg-red-700 active:scale-95 text-white font-medium text-xs shadow-sm hover:shadow-md transition-all cursor-pointer select-none group/watch"
            >
              <Play className="w-3.5 h-3.5 fill-current text-white shrink-0 group-hover/watch:scale-110 transition-transform" />
              <span>{textContent || 'Watch Now'}</span>
            </button>
          );
        }
      }

      let domain = '';
      try {
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          domain = new URL(href).hostname;
        }
      } catch (e) {}

      const faviconUrl = domain
        ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
        : '';

      /**
       * A link to the app the agent just built.
       *
       * The model often prints the preview URL as plain text instead of calling
       * `get_preview_url`, and a bare `<a target="_blank">` is a dead end: the
       * whole point of the docked panel is to keep the chat beside the running
       * app. So the link itself opens the panel, and the new tab stays one small
       * click away for when the page refuses to be framed.
       */
      if (onOpenPreview && isPreviewUrl(href, { allowLoopback: Boolean(message.agent) })) {
        const label = textContent && !/^https?:\/\//i.test(textContent) ? textContent : previewHost(href);
        return (
          <span className="inline-flex items-center gap-0.5 my-0.5 align-baseline" data-testid="preview-link">
            <button
              type="button"
              onClick={() => onOpenPreview(href, label)}
              title="Open it in the panel next to the chat"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md rounded-r-none bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-medium text-[13px] border border-emerald-200/80 dark:border-emerald-500/30 border-r-0 transition-colors cursor-pointer"
              data-testid="open-preview-from-link"
            >
              <PanelRight className="w-3.5 h-3.5 shrink-0" />
              <span className="max-w-[280px] truncate">{label}</span>
            </button>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in a new tab"
              className="inline-flex items-center px-1.5 py-0.5 rounded-md rounded-l-none bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 border-l-0 transition-colors no-underline hover:no-underline"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </span>
        );
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 my-0.5 rounded-md bg-zinc-100/90 dark:bg-zinc-800/80 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-blue-600 dark:text-blue-400 font-medium text-[13px] border border-zinc-200/80 dark:border-zinc-700/70 transition-colors no-underline hover:no-underline align-baseline group/link"
          {...props}
        >
          {faviconUrl && (
            <img
              src={faviconUrl}
              alt=""
              className="w-3.5 h-3.5 rounded-sm object-contain inline-block shrink-0"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          )}
          <span className="truncate max-w-[260px] sm:max-w-[420px]">{children}</span>
        </a>
      );
    },
    img({ src, alt, ...props }: any) {
      const isMoviePoster =
        src &&
        (src.includes('themoviedb.org') ||
          src.includes('tmdb.org') ||
          src.includes('/w500/') ||
          src.includes('/t/p/'));

      if (isMoviePoster) {
        // Collect all movies from tool executions or message blocks
        const allToolMovies: MovieItem[] = [];
        message.blocks?.forEach((b) => {
          if (b.type === 'tool' && b.tool.movies) {
            allToolMovies.push(...b.tool.movies);
          }
        });
        message.toolExecutions?.forEach((t) => {
          if (t.movies) {
            allToolMovies.push(...t.movies);
          }
        });

        const found = allToolMovies.find(
          (m) =>
            m.poster === src ||
            (alt &&
              (m.title.toLowerCase().includes(alt.toLowerCase()) ||
                alt.toLowerCase().includes(m.title.toLowerCase())))
        );

        // Fallback movie details parsed from surrounding content
        const rawText = message.content || '';
        const idMatch = rawText.match(/watch:\/\/(?:movie|tv)\/([0-9]+)/i);
        const yearMatch = rawText.match(/\b(19\d\d|20\d\d)\b/);
        const scoreMatch = rawText.match(/(?:Score|Rating|★|⭐)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const isTv = rawText.includes('watch://tv') || rawText.toLowerCase().includes('[tv]');

        const movieItem: MovieItem = found || {
          id: idMatch ? idMatch[1] : allToolMovies[0]?.id || '',
          title: alt || allToolMovies[0]?.title || 'Movie',
          poster: src,
          media_type: isTv ? 'tv' : 'movie',
          year: yearMatch ? yearMatch[1] : allToolMovies[0]?.year,
          score: scoreMatch ? scoreMatch[1] : allToolMovies[0]?.score,
          overview: allToolMovies[0]?.overview || undefined,
          url: `watch://${isTv ? 'tv' : 'movie'}/${idMatch ? idMatch[1] : ''}`,
        };

        return (
          <div className="my-3 max-w-2xl">
            <MovieCard
              movie={movieItem}
              onWatch={(id, type, title) => onWatchMedia?.(id, type, title)}
            />
          </div>
        );
      }

      return (
        <span className="block my-3 max-w-xl overflow-hidden rounded-xl border border-zinc-200/90 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 shadow-sm">
          <img
            src={src}
            alt={alt || 'Image'}
            loading="lazy"
            className="w-full h-auto object-cover max-h-[460px] rounded-t-xl"
            {...props}
          />
          {alt && (
            <span className="block px-3 py-1.5 text-xs text-zinc-500 dark:text-zinc-400 text-left font-mono border-t border-zinc-200/60 dark:border-zinc-800/60 truncate">
              {alt}
            </span>
          )}
        </span>
      );
    },
    table({ children }: any) {
      return (
        <div className="my-4 w-full overflow-x-auto rounded-xl border border-zinc-200/90 dark:border-zinc-800 shadow-sm bg-white dark:bg-zinc-900/40 overscroll-x-contain">
          <table className="min-w-full w-max text-left border-collapse text-[13px]">
            {children}
          </table>
        </div>
      );
    },
    thead({ children }: any) {
      return (
        <thead className="bg-zinc-50 dark:bg-zinc-800/70 border-b border-zinc-200 dark:border-zinc-700/80">
          {children}
        </thead>
      );
    },
    tbody({ children }: any) {
      return (
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {children}
        </tbody>
      );
    },
    tr({ children }: any) {
      return (
        <tr className="hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 transition-colors">
          {children}
        </tr>
      );
    },
    th({ children }: any) {
      return (
        <th className="px-4 py-2.5 text-[12px] font-semibold tracking-wide text-zinc-900 dark:text-zinc-100 select-none whitespace-nowrap text-left border-b border-zinc-200 dark:border-zinc-700/80 break-normal [word-break:normal]">
          {children}
        </th>
      );
    },
    td({ children }: any) {
      return (
        <td className="px-4 py-3 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300 align-top break-normal [word-break:normal] min-w-[100px]">
          {children}
        </td>
      );
    },
    blockquote({ children }: any) {
      return (
        <blockquote className="my-2.5 border-l-[3px] border-zinc-300 dark:border-zinc-700 pl-3.5 italic text-zinc-600 dark:text-zinc-400">
          {children}
        </blockquote>
      );
    },
  };

  // While a turn is still generating, its per-message actions (Copy / Continue /
  // Regenerate) are hidden — acting on a half-finished answer is never what the
  // user wants. The extra `status === 'running'` checks that used to live here
  // were dead: a trailing `|| true` made the whole expression just
  // `Boolean(message.isGenerating)`.
  const isWorking = Boolean(message.isGenerating);

  /**
   * All the turn's reasoning as one entry.
   *
   * Reasoning arrives in several rounds — one before each burst of tool calls —
   * and the last one is the live one. They are merged: durations added up, rounds
   * concatenated in order, and shown once, where the first of them happened.
   */
  const thinkingAggregate = (() => {
    const parts = blocks.filter((b) => b.type === 'thinking');
    if (!parts.length) return null;
    const content = parts
      .map((b) => b.content)
      .join('\n\n')
      .slice(-60_000);
    const duration = parts.reduce((sum, b) => sum + (b.duration || 0), 0);
    const stillThinking = parts.some((b) => b.isStillThinking) && !message.error;
    return { id: `think-${message.id}`, content, duration, stillThinking, rounds: parts.length };
  })();

  const liveTurn = Boolean(message.isGenerating) && !message.error;

  /**
   * What a finished agent turn shows, and what it keeps behind its one line.
   *
   * Every action of the run — every read, edit, command, search, note — folds
   * into the work row, along with the reasoning and the lines the agent said
   * along the way. What stays on screen is the answer the run ended with. While
   * the turn is still running nothing is folded yet: the lines it is writing stay
   * in front of the reader, and they move into the row when it is done.
   */
  const textBlocks = blocks.filter((b) => b.type === 'text');
  /**
   * The preview a run ended with stands OUTSIDE the work row: it is the one thing
   * in a finished turn the user is meant to click, and burying the way to see the
   * app behind one more click would be silly. The last one wins — it is the build
   * that is up now — and it is taken out of the trail so it cannot appear twice.
   */
  const previewAction = (() => {
    const done = blocks.filter(
      (b) => b.type === 'action' && b.action.tool === 'get_preview_url' && b.action.result?.url
    ) as Array<Extract<MessageBlock, { type: 'action' }>>;
    return done.length ? done[done.length - 1].action : null;
  })();
  const inFold = (block: MessageBlock) => !(previewAction && block.type === 'action' && block.action.id === previewAction.id);
  const visibleText = liveTurn ? textBlocks : textBlocks.slice(-1);
  const visibleTextIds = new Set(visibleText.map((b) => b.id));
  const foldedText = textBlocks.filter((b) => !visibleTextIds.has(b.id));
  const actionCount = blocks.filter((b) => b.type === 'action' && inFold(b)).length;
  // A turn with nothing to fold (no actions, nothing said along the way) has no
  // work row at all — its reasoning shows in place instead of hiding behind it.
  const hasWorkRow = actionCount > 0 || foldedText.length > 0;

  /** One markdown block of the turn's own words. */
  const textNode = (block: Extract<MessageBlock, { type: 'text' }>, inTrail: boolean) => {
    if (block.notice) {
      return (
        <div key={block.id} className="my-1.5 text-[12px] italic text-zinc-400 dark:text-zinc-500">
          {block.content}
        </div>
      );
    }
    return (
      <div
        key={block.id}
        className={`markdown-body my-2${block.id === liveTextId ? ' is-streaming' : ''}${
          inTrail && block.content.length > 1200 ? ' text-[13px]' : ''
        }`}
      >
        <MarkdownBlock
          content={normalizeMessageContent(block.content)}
          streaming={block.id === liveTextId}
          components={markdownComponents}
        />
      </div>
    );
  };

  /**
   * Everything the run did, in the order it did it: the reasoning where it
   * happened, the lines it said, and the actions in tight groups.
   */
  const renderTrail = () => {
    const out: React.ReactNode[] = [];
    let group: AgentAction[] = [];
    let thinkingShown = false;
    const flush = () => {
      if (group.length === 0) return;
      const first = group[0].id;
      out.push(
        <div key={`g-${first}`} className="my-1.5">
          <AgentTrail
            trailId={`${message.id}:${first}`}
            actions={group}
            onApproval={onAgentApproval}
            onOpenPreview={onOpenPreview}
          />
        </div>
      );
      group = [];
    };
    for (const block of blocks) {
      if (block.type === 'action') {
        if (!inFold(block)) continue; // the preview row stands on its own, outside
        group.push(block.action);
        continue;
      }
      if (block.type === 'text' && visibleTextIds.has(block.id)) continue;
      flush();
      if (block.type === 'thinking') {
        if (!thinkingAggregate || thinkingShown) continue; // one entry for the whole turn
        thinkingShown = true;
        out.push(
          <ThinkingEntry
            key={thinkingAggregate.id}
            content={thinkingAggregate.content}
            duration={thinkingAggregate.duration || undefined}
            rounds={thinkingAggregate.rounds}
            active={liveTurn && thinkingAggregate.stillThinking}
          />
        );
      } else if (block.type === 'text') {
        out.push(textNode(block, true));
      }
    }
    flush();
    return out;
  };

  /**
   * One clock for the whole turn. While it runs it appears on the working line;
   * when it finishes the same number is what the footer reports, so the work time
   * is stated once, in one place, instead of after every command.
   */
  const firstActionAt = blocks.find((b) => b.type === 'action')?.action.startedAt;
  const elapsedSeconds = useElapsedSeconds(Boolean(message.isGenerating) && !message.error, firstActionAt ?? null);

  /**
   * A live turn before its first action has no work row yet, and the answer it
   * is writing is not always on screen — so the quiet "Working…" line is kept
   * for exactly those moments, and only while nothing else is being written.
   */
  const lastBlock = blocks[blocks.length - 1];
  const textIsStreaming = lastBlock?.type === 'text' && lastBlock.id === liveTextId;
  const showIdleWorking =
    liveTurn && !hasWorkRow && !textIsStreaming && !thinkingAggregate?.stillThinking;

  /**
   * The label on the live line. "Thinking…" while a round of reasoning is being
   * written, the provider's own note if it has one ("Provider busy — retrying…"),
   * and "Working…" for everything else — the moments between steps, a command
   * still running, a file being written.
   */
  const workingText =
    thinkingAggregate?.stillThinking
      ? 'Thinking…'
      : message.agentStatus && message.agentStatus !== 'Working…'
        ? message.agentStatus
        : 'Working…';

  const runLine = !message.isGenerating ? workedSummary(message.agentRun) : undefined;
  const notice = !message.isGenerating ? stopNotice(message.agentRun?.stopReason) : undefined;
  const runFooter =
    runLine || notice ? (
      <div
        className="mt-2.5 text-[12px] leading-5 text-zinc-400 dark:text-zinc-500 select-none"
        data-testid="agent-run-footer"
      >
        {runLine ? <span>{runLine}</span> : null}
        {runLine && notice ? <span className="text-zinc-300 dark:text-zinc-600"> · </span> : null}
        {notice ? <span>{notice}</span> : null}
      </div>
    ) : null;

  // Assistant / AI Message: left-aligned, natural flow
  return (
    <div className="flex justify-start w-full group text-left">
      <div className="w-full text-zinc-900 dark:text-zinc-100">
        {/* Timeline blocks: tools and thinking rendered in chronological sequence */}
        {blocks.length > 0 && !isAgentTimeline && (
          <div className="mb-2 space-y-1">
            {blocks.map((block) => {
              if (block.type === 'tool') {
                return (
                  <ToolExecutionCard
                    key={block.id}
                    tool={block.tool}
                    onWatch={onWatchMedia}
                  />
                );
              }
              if (block.type === 'thinking') {
                // Same rule as the agent timeline: one row for the whole turn, all
                // the reasoning rounds merged into it.
                if (block.id !== blocks.find((b) => b.type === 'thinking')?.id) return null;
                const stillThinking = Boolean(
                  (block.isStillThinking ?? isStillThinking) && !message.error
                );
                return (
                  <ThinkingSection
                    key={block.id}
                    id={block.id}
                    thinkingContent={thinkingAggregate?.content ?? block.content}
                    isStillThinking={stillThinking}
                    thinkingDuration={thinkingAggregate?.duration || block.duration}
                    rounds={thinkingAggregate?.rounds}
                  />
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Agent turn: thinking, narration and actions in the exact order they happened */}
        {isAgentTimeline && (
          <div data-testid="agent-timeline">
            {/*
              The order of a finished turn: what the run did — one line, with the
              whole run behind it — then the preview it produced, then the answer
              it ended with. The work line sits above the answer on purpose: it is
              the work that produced it.
            */}
            {hasWorkRow ? (
              <AgentWorkRow
                messageId={message.id}
                live={liveTurn}
                liveLabel={workingText}
                elapsedSeconds={elapsedSeconds}
                summary={runLine}
                notice={notice}
              >
                {renderTrail()}
              </AgentWorkRow>
            ) : (
              <>
                {/* Nothing to fold: the reasoning stands where it happened, and the
                    turn's numbers are a plain line under it. */}
                {/*
                  A turn with no work to fold still has its reasoning — and it is
                  still the user's to open, not the model's to show: one small row,
                  closed, that says how long it thought and opens on a click. Left
                  as a plain block it was the one place in the app where something
                  was on screen for good, with no way to put it away.
                */}
                {!thinkingAggregate ? null : (
                  <div className="my-1">
                    <ThinkingSection
                      id={thinkingAggregate.id}
                      thinkingContent={thinkingAggregate.content}
                      isStillThinking={thinkingAggregate.stillThinking}
                      thinkingDuration={thinkingAggregate.duration || undefined}
                      rounds={thinkingAggregate.rounds}
                    />
                  </div>
                )}
                {showIdleWorking ? (
                  <div className="mt-1 text-[13px] leading-6 select-none">
                    <span className="agent-shimmer">{workingText}</span>
                    {elapsedSeconds >= 2 && (
                      <span className="ml-1.5 text-[12px] text-zinc-400 dark:text-zinc-500">{elapsedSeconds}s</span>
                    )}
                  </div>
                ) : null}
                {runFooter}
              </>
            )}

            {/* The running app, one click from the chat it was built in. */}
            {previewAction ? (
              <div className="my-1.5">
                <AgentActionRow action={previewAction} onApproval={onAgentApproval} onOpenPreview={onOpenPreview} />
              </div>
            ) : null}

            {/* The turn's own words: the lines it is saying now, and — once it is
                over — the answer it ended with. */}
            {visibleText.map((block) => textNode(block as Extract<MessageBlock, { type: 'text' }>, false))}

            {/* An agent turn whose content arrived without blocks (an error, an
                older saved chat) still shows its answer instead of nothing. */}
            {textBlocks.length === 0 && safeMessageContent.trim() ? (
              <div className={`markdown-body${message.isGenerating && !message.error ? ' is-streaming' : ''}`}>
                <MarkdownBlock content={normalizeMessageContent(safeMessageContent)} streaming={message.isGenerating} components={markdownComponents} />
              </div>
            ) : null}
          </div>
        )}

        {/* Typing dot — ONLY while actually generating. Suppressed while
            tool/thinking cards are on screen or content is present. */}
        {!isAgentTimeline &&
        message.isGenerating &&
        !safeMessageContent.trim() &&
        !message.error &&
        blocks.length === 0 ? (
          <div className="flex items-center h-6">
            <span className="w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse" />
          </div>
        ) : safeMessageContent.trim() && !isAgentTimeline ? (
          <div className={`markdown-body${message.isGenerating && !message.error ? ' is-streaming' : ''}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
              urlTransform={(uri) => uri}
            >
              {(() => {
                let text = streamedContent;
                const hasPoster =
                  text.includes('themoviedb.org') ||
                  text.includes('tmdb.org') ||
                  text.includes('/w500/') ||
                  text.includes('/t/p/');
                if (hasPoster) {
                  text = text
                    .replace(/(?:\*{0,2}(?:Watch Stream:?|Watch:?)\*{0,2}\s*)?▶?\s*\[(?:▶\s*)?Watch Now\]\(watch:\/\/[^)]+\)/gi, '')
                    .replace(/▶\s*\[(?:▶\s*)?Watch Now\]\([^)]+\)/gi, '')
                    .replace(/\n\s*▶\s*\n/g, '\n')
                    .replace(/\n\s*▶\s*$/g, '')
                    .trim();
                }
                return text;
              })()}
            </ReactMarkdown>
          </div>
        ) : null}

        {/* Action icons below AI response: Copy + Regenerate + Continue on hover (ONLY shown when NOT working!) */}
        {!isWorking && safeMessageContent.trim() && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 touch-reveal focus-within:opacity-100 transition-opacity select-none pointer-events-auto">
            {safeMessageContent.trim() && (
              <button
                type="button"
                onClick={handleCopyMessage}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none"
                title="Copy response"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-[11px] text-emerald-500 select-none">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 stroke-[1.75] shrink-0" />
                    <span className="text-[11px] select-none">Copy</span>
                  </>
                )}
              </button>
            )}

            {onContinueResponse && (
              <button
                type="button"
                onClick={() => onContinueResponse(message.id)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none"
                title="Resume / Continue task with full memory"
              >
                <Play className="w-3.5 h-3.5 stroke-[1.75] shrink-0" />
                <span className="text-[11px] select-none">Continue</span>
              </button>
            )}

            {onRegenerateResponse && (
              <button
                type="button"
                onClick={() => onRegenerateResponse(message.id)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none"
                title="Regenerate response"
              >
                <RotateCcw className="w-3.5 h-3.5 stroke-[1.75] shrink-0" />
                <span className="text-[11px] select-none">Regenerate</span>
              </button>
            )}
          </div>
        )}

        {message.error && (
          <div className="mt-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 text-xs">
            {message.error}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Memoised on purpose: while an answer streams, `syncMessageState` rebuilds the
 * conversation on every token. Without this, every message in the chat re-rendered
 * — markdown, code blocks and the whole tool trail — for each token of the last
 * one. With it, React skips every message whose props are unchanged, and the app
 * passes stable callbacks so that is actually possible (see useStable).
 */
export const ChatMessage = React.memo(ChatMessageInner);
ChatMessage.displayName = 'ChatMessage';
