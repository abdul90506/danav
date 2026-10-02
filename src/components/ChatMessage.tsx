import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Brain, ChevronDown, Pencil, RotateCcw, Play, File, Folder } from 'lucide-react';
import { Message, MessageBlock, MovieItem } from '../types';
import { CodeBlock } from './CodeBlock';
import { ToolExecutionCard } from './ToolExecutionCard';
import { MovieCard } from './MovieCard';
import { normalizeMessageContent } from '../utils/markdownNormalize';

interface ChatMessageProps {
  message: Message;
  onEditUserMessage?: (messageId: string, newContent: string) => void;
  onRegenerateResponse?: (assistantMessageId: string) => void;
  onContinueResponse?: (assistantMessageId: string) => void;
  onWatchMedia?: (mediaId: string, mediaType: 'movie' | 'tv' | string, title?: string) => void;
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
  thinkingContent: string;
  isStillThinking: boolean;
  thinkingDuration?: number;
}

const ThinkingSection: React.FC<ThinkingSectionProps> = ({
  thinkingContent,
  isStillThinking,
  thinkingDuration,
}) => {
  // Auto-hide when thinking completes; open by default while still thinking
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const isExpanded = userToggled !== null ? userToggled : isStillThinking;

  // Whenever the reasoning state flips (streaming -> done, or a new thought
  // starts), drop any manual toggle so the box auto-collapses the moment the
  // model stops thinking. Without this the box stayed open forever once the
  // user had peeked inside — the bug where "thinking ho gayi" but the panel
  // kept showing the reasoning.
  React.useEffect(() => {
    setUserToggled(null);
  }, [isStillThinking]);

  const thinkBoxRef = useRef<HTMLDivElement>(null);
  const isThinkAutoScrollPausedRef = useRef<boolean>(false);

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

  // Auto-scroll ONLY inside think box without triggering outer chat scrolling
  React.useEffect(() => {
    if (!isExpanded || !isStillThinking) return;
    if (isThinkAutoScrollPausedRef.current) return;

    const el = thinkBoxRef.current;
    if (el) {
      // Direct scrollTop assignment only scrolls this container, zero glitch on parent chat
      el.scrollTop = el.scrollHeight;
    }
  }, [thinkingContent, isExpanded, isStillThinking]);

  // Pause think box auto-scroll if user scrolls up or grabs the scrollbar
  const handleThinkBoxScroll = () => {
    const el = thinkBoxRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 25) {
      isThinkAutoScrollPausedRef.current = true;
    } else {
      isThinkAutoScrollPausedRef.current = false;
    }
  };

  const durationSec = thinkingDuration || liveSeconds || 1;

  return (
    <div className="mb-3.5 select-none">
      {/* Clean inline header: Brain icon on left, Text in middle, Chevron on right. No stat box! */}
      <button
        type="button"
        onClick={() => setUserToggled(!isExpanded)}
        className="inline-flex items-center gap-1.5 py-1 text-xs font-medium cursor-pointer select-none group/think transition-opacity"
      >
        <Brain
          className={`w-3.5 h-3.5 shrink-0 ${
            isStillThinking
              ? 'thinking-brain-shimmer text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400 group-hover/think:text-zinc-700 dark:group-hover/think:text-zinc-200'
          }`}
        />
        {isStillThinking ? (
          <span className="thinking-shimmer text-xs tracking-wide">
            Thinking...
          </span>
        ) : (
          <span className="shiny-text text-xs tracking-wide group-hover/think:opacity-90 transition-opacity">
            Thought for {durationSec}s
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 dark:text-zinc-500 group-hover/think:text-zinc-700 dark:group-hover/think:text-zinc-200 transition-transform duration-200 shrink-0 ${
            isExpanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </button>

      {/* Expanded Thinking Box with smooth scroll & isolated container */}
      {isExpanded && (
        <div className="relative mt-1.5 animate-in fade-in duration-150">
          {/* Subtle top & bottom fades. They stop short of the right edge so the
              scrollbar stays visible instead of being washed out by the gradient. */}
          <div className="pointer-events-none absolute top-0 left-0 right-3 h-4 bg-gradient-to-b from-white dark:from-zinc-950 via-white/80 dark:via-zinc-950/80 to-transparent z-10" />

          <div
            ref={thinkBoxRef}
            onScroll={handleThinkBoxScroll}
            className="panel-scroll max-h-56 overflow-y-auto overscroll-y-contain pr-2.5 pl-3 py-2 border-l-2 border-zinc-200/70 dark:border-zinc-800/70 text-zinc-500 dark:text-zinc-400 text-[13px] leading-relaxed font-sans whitespace-pre-wrap select-text scroll-smooth"
          >
            {thinkingContent}
          </div>

          <div className="pointer-events-none absolute bottom-0 left-0 right-3 h-5 bg-gradient-to-t from-white dark:from-zinc-950 via-white/80 dark:via-zinc-950/80 to-transparent z-10" />
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

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(safeMessageContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy message', e);
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
                {att.previewUrl ? (
                  <img
                    src={att.previewUrl}
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

        {/* User message bubble: strictly hugs text size */}
        <div className="inline-block max-w-[85%] sm:max-w-[75%] rounded-2xl sm:rounded-3xl px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[15px] leading-relaxed break-words whitespace-pre-wrap select-text font-sans">
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

  // Assistant / AI Message: left-aligned, natural flow
  return (
    <div className="flex justify-start w-full group mb-6 text-left">
      <div className="w-full text-zinc-900 dark:text-zinc-100">
        {/* Timeline blocks: tools and thinking rendered in chronological sequence */}
        {blocks.length > 0 && (
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

        {/* Typing dot — ONLY while actually generating. Suppressed while
            tool/thinking cards are on screen or content is present. */}
        {message.isGenerating &&
        !safeMessageContent.trim() &&
        !message.error &&
        blocks.length === 0 ? (
          <div className="flex items-center h-6">
            <span className="w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse" />
          </div>
        ) : safeMessageContent.trim() ? (
          <div className="markdown-body">
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
