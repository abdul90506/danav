import React from 'react';
import { Play, Star, Calendar, Film, Tv, Sparkles } from 'lucide-react';
import { MovieItem } from '../types';

interface MovieCardProps {
  movie: MovieItem;
  onWatch: (id: string, type: string, title: string) => void;
}

export const MovieCard: React.FC<MovieCardProps> = ({ movie, onWatch }) => {
  const isTv = movie.media_type === 'tv';
  const typeLabel = isTv ? 'TV Series' : 'Movie';

  return (
    <div className="group relative flex flex-col sm:flex-row gap-3.5 p-3.5 rounded-2xl bg-white dark:bg-zinc-900/90 border border-zinc-200/90 dark:border-zinc-800 shadow-sm hover:shadow-xl hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-200 select-none">
      {/* Vertical Cinema Poster */}
      <div className="relative w-full sm:w-[130px] h-[195px] sm:h-[185px] shrink-0 rounded-xl overflow-hidden bg-zinc-950 border border-zinc-200/60 dark:border-zinc-800">
        {movie.poster ? (
          <img
            src={movie.poster}
            alt={movie.title}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500 text-xs">
            {isTv ? <Tv className="w-6 h-6 mb-1 opacity-50" /> : <Film className="w-6 h-6 mb-1 opacity-50" />}
            <span>No Poster</span>
          </div>
        )}

        {/* Floating HD / Type Badge */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-black/80 backdrop-blur-md text-white border border-white/10 uppercase font-mono tracking-wider">
            {isTv ? 'SERIES' : 'HD MOVIE'}
          </span>
        </div>

        {/* Quick Play Hover Overlay */}
        <button
          type="button"
          onClick={() => onWatch(movie.id, movie.media_type, movie.title)}
          className="absolute inset-0 bg-black/55 backdrop-blur-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          title={`Watch ${movie.title}`}
        >
          <div className="w-11 h-11 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
        </button>
      </div>

      {/* Movie Details & Stats */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div>
          {/* Title */}
          <div className="flex items-start justify-between gap-2">
            <h4 className="font-semibold text-base sm:text-[17px] text-zinc-900 dark:text-zinc-100 leading-snug truncate">
              {movie.title}
            </h4>
          </div>

          {/* Clean Stat Badges: Year, Rating / Score, Media Type */}
          <div className="flex items-center gap-2 mt-2 flex-wrap text-xs">
            {movie.score && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-500 font-semibold text-xs border border-amber-500/20">
                <Star className="w-3.5 h-3.5 fill-amber-500" />
                <span>{movie.score}</span>
                <span className="text-[10px] opacity-70 font-normal">/10</span>
              </span>
            )}

            {movie.year && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono text-xs">
                <Calendar className="w-3 h-3 text-zinc-400" />
                <span>{movie.year}</span>
              </span>
            )}

            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs">
              {isTv ? <Tv className="w-3 h-3" /> : <Film className="w-3 h-3" />}
              <span>{typeLabel}</span>
            </span>
          </div>

          {/* Overview / Synopsis */}
          {movie.overview && (
            <p className="mt-2.5 text-xs text-zinc-600 dark:text-zinc-400 line-clamp-3 leading-relaxed">
              {movie.overview}
            </p>
          )}
        </div>

        {/* Watch Now Button & Server Badge */}
        <div className="mt-3.5 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between">
          <button
            type="button"
            onClick={() => onWatch(movie.id, movie.media_type, movie.title)}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 active:scale-95 text-white font-medium text-xs shadow-sm hover:shadow-md transition-all cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Watch Now</span>
          </button>

          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 font-mono">
            <Sparkles className="w-3 h-3 text-amber-400" />
            8 Mirrors Ready
          </span>
        </div>
      </div>
    </div>
  );
};
