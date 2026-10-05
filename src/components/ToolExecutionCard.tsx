import React, { useCallback, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Search, Globe, Image as ImageIcon, Film, ChevronDown, AlertCircle, ExternalLink } from 'lucide-react';
import { ToolExecution } from '../types';
import { MovieCard } from './MovieCard';
import { createPanelStore, usePanelOpen } from './panels';
import { useDismissOnOutside } from '../utils/useDismissOnOutside';
import { SearchSourceStack } from './SearchSourceStack';

interface ToolExecutionCardProps {
  tool: ToolExecution;
  onWatch?: (id: string, type: string, title: string) => void;
}

/**
 * The row that shows one web tool the model ran.
 *
 * Rendered inline in the assistant turn, above the answer, so the user can see
 * what was researched and whether it worked — the same visibility agent mode
 * used to give. While the server is still working, only the status text shimmers;
 * a completed web search shows the real source sites, and the raw output remains
 * available on demand.
 */
/**
 * One web-tool card open at a time, chat-wide.
 *
 * The card opens itself while the tool is running — that is the moment its
 * detail is worth watching — and closes again when the tool settles, so a long
 * run of searches does not leave a stack of open panels behind it. A card the
 * user opened by hand stays open. This is the same rule the action rows and the
 * thinking box follow, and it is the same store, so opening one of these closes
 * whatever else was revealed.
 */
const toolStore = createPanelStore();

function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function pageHostLabel(value?: string): string {
  try {
    return new URL(value || '').hostname.replace(/^www\./i, '');
  } catch {
    return value || '';
  }
}

export const ToolExecutionCard: React.FC<ToolExecutionCardProps> = ({ tool, onWatch }) => {
  const expanded = usePanelOpen(toolStore, tool.id);
  const cardRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(cardRef, expanded, useCallback(() => toolStore.close(), []));

  /**
   * The card does not open itself, while it runs or when it settles: the row shows
   * which sites contributed, and the raw output is there for whoever wants it.
   * One is open at a time, chat-wide, and a click anywhere else closes it.
   */
  const toggle = useCallback(() => {
    if (toolStore.get() === tool.id) toolStore.close();
    else toolStore.set(tool.id);
  }, [tool.id]);

  const isRunning = tool.status === 'running';
  const isError = tool.status === 'done' && tool.ok === false;

  const Icon =
    tool.name === 'movie_search'
      ? Film
      : tool.name === 'fetch_url'
        ? Globe
        : tool.name === 'image_search'
          ? ImageIcon
          : Search;

  const verb =
    tool.name === 'movie_search'
      ? 'Movies'
      : tool.name === 'fetch_url'
        ? isRunning ? 'Reading' : 'Read'
        : tool.name === 'image_search'
          ? 'Image search'
          : 'Search';

  const requestedUrl = tool.url || tool.query;
  const pageUrl = tool.name === 'fetch_url' && tool.status === 'done' && tool.ok !== false
    ? safeHttpUrl(requestedUrl)
    : undefined;
  const pageSite = tool.name === 'fetch_url' ? pageHostLabel(pageUrl || requestedUrl) : '';
  const label = tool.name === 'fetch_url'
    ? pageSite || (isRunning ? '…' : '')
    : tool.query || (isRunning ? '…' : '');
  const hasMovies = Boolean(tool.movies && tool.movies.length > 0);
  const hasDetail = Boolean(tool.detail && tool.detail.trim());
  const hasImages = Boolean(tool.images && tool.images.length > 0);
  // Filter out unwanted status strings like "Page read" or "Done"
  const rawSummary = tool.skipped ? 'reused' : tool.summary;
  const cleanSummary =
    rawSummary && rawSummary !== 'Page read' && rawSummary !== 'Done'
      ? rawSummary
      : undefined;
  // Web result counts are deliberately replaced by actual source favicons.
  const accessibleSummary = tool.name === 'web_search' ? undefined : cleanSummary;

  return (
    <div ref={cardRef} className="mb-2 select-none">
      <button
        type="button"
        disabled={!hasDetail && !hasImages}
        aria-expanded={hasDetail || hasImages ? expanded : undefined}
        aria-controls={hasDetail || hasImages ? `tool-detail-${tool.id}` : undefined}
        aria-label={`${verb}${label ? `: ${label}` : ''}${isRunning ? ', working' : isError ? ', failed' : accessibleSummary ? `, ${accessibleSummary}` : ''}${hasDetail || hasImages ? expanded ? ', hide details' : ', show details' : ''}`}
        aria-busy={isRunning}
        onClick={toggle}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 py-1 text-xs font-medium transition-opacity disabled:cursor-default ${
          hasDetail || hasImages ? 'cursor-pointer group/tool' : 'cursor-default'
        }`}
      >
        <Icon
          className={`w-3.5 h-3.5 shrink-0 ${
            isRunning
              ? 'text-zinc-500 dark:text-zinc-400'
              : isError
                ? 'text-amber-500'
                : 'text-zinc-500 dark:text-zinc-400'
          }`}
        />

        <span className="text-zinc-500 dark:text-zinc-400 shrink-0">{verb}</span>

        {label && (
          <span
            className={`min-w-0 truncate max-w-[240px] sm:max-w-[420px] ${
              isRunning
                ? 'text-zinc-600 dark:text-zinc-300'
                : isError
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-zinc-700 dark:text-zinc-200'
            }`}
          >
            {label}
          </span>
        )}

        {isRunning ? (
          <span className="thinking-shimmer text-[11px] tracking-wide shrink-0">working…</span>
        ) : isError ? (
          <span className="inline-flex items-center gap-1 shrink-0 text-amber-600 dark:text-amber-400 text-[11px]">
            <AlertCircle className="w-3 h-3 text-amber-500" />
            <span>Failed</span>
          </span>
        ) : tool.name === 'web_search' ? (
          <SearchSourceStack sources={tool.sources} className="ml-0.5" />
        ) : cleanSummary ? (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
            {cleanSummary}
          </span>
        ) : null}

        {(hasDetail || hasImages) && (
          <ChevronDown
            className={`w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0 transition-transform duration-200 group-hover/tool:text-zinc-600 dark:group-hover/tool:text-zinc-300 ${
              expanded ? 'rotate-0' : '-rotate-90'
            }`}
          />
        )}
      </button>

      {pageUrl && (
        <a
          href={pageUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${pageSite || 'source page'} in a new tab`}
          title={tool.title ? `Open ${tool.title}` : `Open ${pageSite}`}
          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}

      {expanded && (
        <div id={`tool-detail-${tool.id}`} className="mt-1.5 animate-in fade-in duration-150">
          {hasMovies && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 max-w-3xl">
              {tool.movies!.map((movie) => (
                <MovieCard
                  key={movie.id}
                  movie={movie}
                  onWatch={(id, type, title) => onWatch?.(id, type, title)}
                />
              ))}
            </div>
          )}

          {hasImages && (
            <div className="flex flex-wrap gap-2 mb-2 max-w-2xl">
              {tool.images!.map((img) => (
                <a
                  key={img.url}
                  href={img.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-24 h-24 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
                  title={img.title}
                >
                  <img
                    src={img.thumbnail || img.url}
                    alt={img.title}
                    loading="lazy"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                    }}
                  />
                </a>
              ))}
            </div>
          )}

          {hasDetail && !hasMovies && (
            tool.name === 'fetch_url' ? (
              <div
                className="panel-scroll max-h-[65vh] max-w-3xl overflow-y-auto overscroll-y-contain pr-3 pl-3 py-2 border-l-2 border-zinc-200/70 dark:border-zinc-800/70 text-zinc-600 dark:text-zinc-300 text-[12px] leading-relaxed whitespace-normal break-words select-text [&_h1]:mb-2 [&_h1]:mt-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-sky-700 [&_a]:underline [&_a]:decoration-sky-500/40 [&_a]:underline-offset-2 dark:[&_a]:text-sky-300 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 dark:[&_blockquote]:border-zinc-700 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-100 [&_pre]:p-2 dark:[&_pre]:bg-zinc-900 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 dark:[&_code]:bg-zinc-900 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_th]:border [&_th]:border-zinc-200 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-zinc-200 [&_td]:px-2 [&_td]:py-1 dark:[&_th]:border-zinc-700 dark:[&_td]:border-zinc-700"
                aria-label={`Fetched Markdown page${pageSite ? ` from ${pageSite}` : ''}`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  urlTransform={defaultUrlTransform}
                  components={{
                    a: ({ href, children }) => href
                      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                      : <>{children}</>,
                    img: ({ src, alt }) => src
                      ? <img src={src} alt={alt || ''} loading="lazy" className="my-2 max-h-80 max-w-full rounded-md object-contain" />
                      : null,
                  }}
                >
                  {tool.detail!}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="panel-scroll max-h-56 overflow-y-auto overscroll-y-contain pr-2.5 pl-3 py-2 border-l-2 border-zinc-200/70 dark:border-zinc-800/70 text-zinc-500 dark:text-zinc-400 text-[12px] leading-relaxed font-mono whitespace-pre-wrap select-text">
                {tool.detail}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
