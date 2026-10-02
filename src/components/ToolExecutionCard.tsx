import React, { useState } from 'react';
import { Search, Globe, Image as ImageIcon, Film, ChevronDown, AlertCircle } from 'lucide-react';
import { ToolExecution } from '../types';
import { MovieCard } from './MovieCard';

interface ToolExecutionCardProps {
  tool: ToolExecution;
  onWatch?: (id: string, type: string, title: string) => void;
}

/**
 * The row that shows one web tool the model ran.
 *
 * Rendered inline in the assistant turn, above the answer, so the user can see
 * what was researched and whether it worked — the same visibility agent mode
 * used to give. While the server is still working the row pulses; when it
 * finishes it settles into "N results" / "Page read" / a failure, and can be
 * expanded to inspect the raw output the model actually read.
 */
export const ToolExecutionCard: React.FC<ToolExecutionCardProps> = ({ tool, onWatch }) => {
  const [expanded, setExpanded] = useState(true);

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
        ? 'Reading'
        : tool.name === 'image_search'
          ? 'Image search'
          : 'Search';

  const label = tool.query || (isRunning ? '…' : '');
  const hasMovies = Boolean(tool.movies && tool.movies.length > 0);
  const hasDetail = Boolean(tool.detail && tool.detail.trim());
  const hasImages = Boolean(tool.images && tool.images.length > 0);
  // Filter out unwanted status strings like "Page read" or "Done"
  const rawSummary = tool.skipped ? 'reused' : tool.summary;
  const cleanSummary =
    rawSummary && rawSummary !== 'Page read' && rawSummary !== 'Done'
      ? rawSummary
      : undefined;

  return (
    <div className="mb-2 select-none">
      <button
        type="button"
        onClick={() => (hasDetail || hasImages) && setExpanded((v) => !v)}
        className={`inline-flex items-center gap-1.5 max-w-full py-1 text-xs font-medium transition-opacity ${
          hasDetail || hasImages ? 'cursor-pointer group/tool' : 'cursor-default'
        }`}
      >
        <Icon
          className={`w-3.5 h-3.5 shrink-0 ${
            isRunning
              ? 'text-zinc-500 dark:text-zinc-400 animate-pulse'
              : isError
                ? 'text-amber-500'
                : 'text-zinc-500 dark:text-zinc-400'
          }`}
        />

        <span className="text-zinc-500 dark:text-zinc-400 shrink-0">{verb}</span>

        {label && (
          <span
            className={`truncate max-w-[240px] sm:max-w-[420px] ${
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

      {expanded && (
        <div className="mt-1.5 animate-in fade-in duration-150">
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
            <div className="panel-scroll max-h-56 overflow-y-auto overscroll-y-contain pr-2.5 pl-3 py-2 border-l-2 border-zinc-200/70 dark:border-zinc-800/70 text-zinc-500 dark:text-zinc-400 text-[12px] leading-relaxed font-mono whitespace-pre-wrap select-text">
              {tool.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
