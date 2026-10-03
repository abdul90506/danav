import React, { useState, useRef, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Brain, ChevronDown, Pencil, RotateCcw, Play, File, Folder, ExternalLink, PanelRight } from 'lucide-react';
import { AgentAction, Message, MessageBlock, MovieItem } from '../types';
import { CodeBlock } from './CodeBlock';
import { ToolExecutionCard } from './ToolExecutionCard';
import { MovieCard } from './MovieCard';
import { copyText } from '../utils/clipboard.ts';
import { normalizeMessageContent } from '../utils/markdownNormalize';
import { isPreviewUrl, previewHost } from '../utils/previewUrl';
import { AgentActionRow } from './AgentActionRow';
import { getOpenThinkingId, setOpenThinkingId, subscribeThinkingAccordion } from './thinkingAccordion';
import { changedSummary, isLive, stopNotice } from '../agent/format';

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

interface ThinkingSectionProps {
  /** Stable id for the accordion: only one thinking block is open in the whole chat. */
  id: string;
  thinkingContent: string;
  isStillThinking: boolean;
  thinkingDuration?: number;
}

const ThinkingSection: React.FC<ThinkingSectionProps> = ({
  id,
  thinkingContent,
  isStillThinking,
  thinkingDuration,
}) => {
  // One thought open at a time, chat-wide: opening this one closes the others.
  const openId = useSyncExternalStore(subscribeThinkingAccordion, getOpenThinkingId);
  const isExpanded = openId === id;

  const thinkBoxRef = useRef<HTMLDivElement>(null);
  /** The user scrolled this box themselves: stop following until they come back down. */
  const pausedRef = useRef(false);
  /** Scroll events before this moment are ours, not the user's. */
  const ignoreScrollUntilRef = useRef(0);
  /** We opened this box because it was streaming, so we may close it again when it stops. */
  const autoOpenedRef = useRef(false);
  /** The user opened this box on purpose: leave it alone when the reasoning ends. */
  const userPinnedRef = useRef(false);

  // While the model is reasoning, its box is the one on screen. When the reasoning
  // stops the box closes itself, so the answer gets the room — unless the user
  // opened it deliberately to read it.
  React.useEffect(() => {
    if (isStillThinking) {
      if (!autoOpenedRef.current) {
        autoOpenedRef.current = true;
        pausedRef.current = false;
        setOpenThinkingId(id);
      }
      return;
    }
    if (autoOpenedRef.current) {
      autoOpenedRef.current = false;
      if (!userPinnedRef.current && getOpenThinkingId() === id) setOpenThinkingId(null);
    }
  }, [id, isStillThinking]);

  // Live timer while thinking is actively running
  const [liveSeconds, setLiveSeconds] = useState<number>(() => thinkingDuration || 1);
  const startTimeRef = useRef<number>(Date.now());

  React.useEffect(() => {
    if (!isStillThinking) {
      if (thinkingDuration) {
        setLiveSeconds(thinkingDuration);
      }
      return;
    }
    startTimeRef.current = Date.now();
    const timer = setInterval(() => {
      setLiveSeconds(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [isStillThinking, thinkingDuration]);

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

  const toggle = () => {
    if (isExpanded) {
      userPinnedRef.current = false;
      setOpenThinkingId(null);
    } else {
      userPinnedRef.current = true;
      setOpenThinkingId(id);
    }
  };

  // While reasoning streams, render it line by line so each new line can fade
  // in (see `.stream-lines` in index.css). Long blocks fall back to one text
  // node — the fade is a nicety, not worth a thousand spans per frame.
  const streamLines = React.useMemo(() => {
    if (!isStillThinking) return null;
    const lines = thinkingContent.split('\n');
    return lines.length <= 400 ? lines : null;
  }, [thinkingContent, isStillThinking]);

  const durationSec = thinkingDuration || liveSeconds || 1;

  return (
    <div className="mb-3.5 select-none">
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
          <span className="thinking-shimmer text-xs tracking-wide">Thinking...</span>
        ) : (
          <span className="text-xs tracking-wide text-zinc-700 dark:text-zinc-200 group-hover/think:text-zinc-900 dark:group-hover/think:text-zinc-50 transition-colors">
            Thought for {durationSec}s
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 dark:text-zinc-500 group-hover/think:text-zinc-700 dark:group-hover/think:text-zinc-200 transition-transform duration-200 shrink-0 ${
            isExpanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </button>

      {/* Expanded Thinking Box with its own scroll container */}
      {isExpanded && (
        <div className="relative mt-1.5 animate-in fade-in duration-150">
          <div
            ref={thinkBoxRef}
            onScroll={handleThinkBoxScroll}
            className="panel-scroll max-h-64 overflow-y-auto overscroll-y-contain px-3.5 py-3 rounded-r-xl border-l-2 border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 text-zinc-800 dark:text-zinc-200 text-sm leading-6 font-normal font-sans whitespace-pre-wrap select-text"
          >
            {streamLines ? (
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

export const ChatMessage: React.FC<ChatMessageProps> = ({
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
        <div className="flex items-center gap-0.5 mt-1 mr-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
        <th className="px-4 py-2.5 text-[12.5px] font-semibold tracking-wide text-zinc-900 dark:text-zinc-100 select-none whitespace-nowrap text-left border-b border-zinc-200 dark:border-zinc-700/80 break-normal [word-break:normal]">
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

  /** thinking / narration / action rows, in order; consecutive actions share one tight group */
  const renderAgentTimeline = () => {
    const out: React.ReactNode[] = [];
    let group: AgentAction[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const first = group[0].id;
      out.push(
        <div key={`g-${first}`} className="my-1.5 space-y-px">
          {group.map((a) => (
            <AgentActionRow key={a.id} action={a} onApproval={onAgentApproval} onOpenPreview={onOpenPreview} />
          ))}
        </div>
      );
      group = [];
    };
    for (const block of blocks) {
      if (block.type === 'action') {
        group.push(block.action);
        continue;
      }
      flush();
      if (block.type === 'thinking') {
        out.push(
          <div key={block.id} className="my-1">
            <ThinkingSection
              id={block.id}
              thinkingContent={block.content}
              isStillThinking={Boolean(block.isStillThinking && !message.error)}
              thinkingDuration={block.duration}
            />
          </div>
        );
      } else if (block.type === 'text') {
        out.push(
          block.notice ? (
            <div key={block.id} className="my-1.5 text-[12px] italic text-zinc-400 dark:text-zinc-500">
              {block.content}
            </div>
          ) : (
            <div key={block.id} className={`markdown-body my-2${block.id === liveTextId ? ' is-streaming' : ''}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={(uri) => uri}>
                {normalizeMessageContent(block.content)}
              </ReactMarkdown>
            </div>
          )
        );
      }
    }
    flush();
    return out;
  };

  // "Working…" fills the quiet moments between steps (the model is deciding what to do next).
  const lastBlock = blocks[blocks.length - 1];
  const showWorking =
    Boolean(message.isGenerating) &&
    !message.error &&
    (!lastBlock ||
      (lastBlock.type === 'action' && !isLive(lastBlock.action)) ||
      (lastBlock.type === 'thinking' && !lastBlock.isStillThinking) ||
      (lastBlock.type === 'text' && Boolean(lastBlock.notice)));
  const workingText = message.agentStatus && message.agentStatus !== 'Working…' ? message.agentStatus : 'Working…';

  const summary = !message.isGenerating ? changedSummary(message.agentRun?.changed) : undefined;
  const notice = !message.isGenerating ? stopNotice(message.agentRun?.stopReason) : undefined;
  const runFooter =
    summary || notice ? (
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-zinc-400 dark:text-zinc-500 select-none" data-testid="agent-run-footer">
        {summary && (
          <span>
            Changed {summary.files} file{summary.files === 1 ? '' : 's'}{' '}
            {summary.added > 0 && <span className="font-mono text-emerald-600 dark:text-emerald-400">+{summary.added}</span>}
            {summary.added > 0 && summary.removed > 0 && ' '}
            {summary.removed > 0 && <span className="font-mono text-rose-500 dark:text-rose-400">−{summary.removed}</span>}
          </span>
        )}
        {notice && <span>{notice}</span>}
      </div>
    ) : null;

  // Assistant / AI Message: left-aligned, natural flow
  return (
    <div className="flex justify-start w-full group mb-6 text-left">
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
                const stillThinking = Boolean(
                  (block.isStillThinking ?? isStillThinking) && !message.error
                );
                return (
                  <ThinkingSection
                    key={block.id}
                    id={block.id}
                    thinkingContent={block.content}
                    isStillThinking={stillThinking}
                    thinkingDuration={block.duration}
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
            {renderAgentTimeline()}
            {showWorking && (
              <div className="mt-1 text-[13px] leading-6 select-none">
                <span className="agent-shimmer">{workingText}</span>
              </div>
            )}
            {runFooter}
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
                let text = safeMessageContent;
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
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity select-none pointer-events-auto">
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
