import React, { useState, useEffect } from 'react';
import { X, Server, Maximize2, Minimize2, Tv, Layers, Check } from 'lucide-react';

export interface MoviePlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaId: string;
  mediaType: 'movie' | 'tv' | string;
  title?: string;
  initialSeason?: number;
  initialEpisode?: number;
}

export interface StreamServer {
  id: string;
  name: string;
  badge?: string;
  getUrl: (id: string, type: string, season: number, episode: number) => string;
}

/**
 * Multi-Server Mirrors:
 * Fast, ad-reduced video streaming sources
 */
export const STREAM_SERVERS: StreamServer[] = [
  {
    id: 'server1',
    name: 'Server 1',
    badge: 'Netflix UI',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://vaplayer.ru/embed/tv/${id}/${s}/${ep}?skin=netflix`
        : `https://vaplayer.ru/embed/movie/${id}?skin=netflix`,
  },
  {
    id: 'server2',
    name: 'Server 2',
    badge: 'VidLink Fast',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://vidlink.pro/tv/${id}/${s}/${ep}?primaryColor=e50914&iconColor=ffffff`
        : `https://vidlink.pro/movie/${id}?primaryColor=e50914&iconColor=ffffff`,
  },
  {
    id: 'server3',
    name: 'Server 3',
    badge: 'VidSrc PRO',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://vidsrcme.ru/embed/tv?tmdb=${id}&season=${s}&episode=${ep}`
        : `https://vidsrcme.ru/embed/movie?tmdb=${id}`,
  },
  {
    id: 'server4',
    name: 'Server 4',
    badge: 'AutoEmbed 4K',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://autoembed.co/tv/tmdb/${id}/${s}/${ep}`
        : `https://autoembed.co/movie/tmdb/${id}`,
  },
  {
    id: 'server5',
    name: 'Server 5',
    badge: 'SuperEmbed VIP',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${ep}`
        : `https://multiembed.mov/?video_id=${id}&tmdb=1`,
  },
  {
    id: 'server6',
    name: 'Server 6',
    badge: '2Embed Cinema',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${ep}`
        : `https://www.2embed.cc/embed/${id}`,
  },
  {
    id: 'server7',
    name: 'Server 7',
    badge: 'VidSrc.to Ultra',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://vidsrc.to/embed/tv/${id}/${s}/${ep}`
        : `https://vidsrc.to/embed/movie/${id}`,
  },
  {
    id: 'server8',
    name: 'Server 8',
    badge: 'SmashyStream',
    getUrl: (id, type, s, ep) =>
      type === 'tv'
        ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${s}&episode=${ep}`
        : `https://embed.smashystream.com/playere.php?tmdb=${id}`,
  },
];

export const MoviePlayerModal: React.FC<MoviePlayerModalProps> = ({
  isOpen,
  onClose,
  mediaId,
  mediaType,
  title,
  initialSeason = 1,
  initialEpisode = 1,
}) => {
  const [selectedServerId, setSelectedServerId] = useState<string>('server1');
  const [season, setSeason] = useState<number>(initialSeason);
  const [episode, setEpisode] = useState<number>(initialEpisode);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !mediaId) return null;

  const isTv = mediaType === 'tv';
  const cleanType = isTv ? 'tv' : 'movie';
  const currentServer =
    STREAM_SERVERS.find((s) => s.id === selectedServerId) || STREAM_SERVERS[0];
  const embedUrl = currentServer.getUrl(mediaId, cleanType, season, episode);

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/85 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Floating Modal Frame: NO header bar, NO footer bar, just 16:9 player + right-side server panel */}
      <div
        className={`relative flex flex-col lg:flex-row bg-zinc-950/90 backdrop-blur-2xl text-white rounded-2xl sm:rounded-3xl border border-white/15 shadow-[0_30px_90px_rgba(0,0,0,0.9)] overflow-hidden transition-all duration-200 ${
          isFullscreen
            ? 'w-full h-full max-w-none rounded-none'
            : 'w-full max-w-6xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left / Center: Strict 16:9 Aspect Ratio Embed Video Player (Flush to edges) */}
        <div className="relative flex-1 min-w-0 bg-black aspect-video flex items-center justify-center">
          <iframe
            key={`${selectedServerId}-${cleanType}-${mediaId}-${season}-${episode}`}
            src={embedUrl}
            title={title || 'Player'}
            className="w-full h-full border-0"
            allowFullScreen
            allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *"
            referrerPolicy="origin"
          />
        </div>

        {/* Right Side: Transparent Glass Sidebar for Servers & TV Controls (Matching Height) */}
        <div className="w-full lg:w-72 xl:w-80 shrink-0 bg-zinc-950/60 backdrop-blur-2xl border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col p-3.5 sm:p-4 gap-3 max-h-[50vh] lg:max-h-none overflow-y-auto">
          {/* Minimal Top Bar in Sidebar: Title + Fullscreen + Close */}
          <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-white/10">
            <div className="min-w-0">
              <h4 className="text-xs sm:text-sm font-semibold truncate text-zinc-100">
                {title || 'Now Playing'}
              </h4>
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 mt-0.5 font-mono">
                <span className="uppercase text-red-400 font-bold">{cleanType}</span>
                {isTv && <span>• S{season} E{episode}</span>}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={toggleFullscreen}
                className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all cursor-pointer"
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Servers Header */}
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
              <Server className="w-3 h-3 text-red-500" />
              Servers
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {STREAM_SERVERS.length} available
            </span>
          </div>

          {/* Simple Transparent Server Buttons */}
          <div className="grid grid-cols-2 gap-1.5">
            {STREAM_SERVERS.map((server) => {
              const isActive = server.id === selectedServerId;
              return (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => setSelectedServerId(server.id)}
                  className={`flex flex-col items-start px-2.5 py-1.5 rounded-xl text-left transition-all cursor-pointer ${
                    isActive
                      ? 'bg-red-600/90 text-white shadow-[0_0_12px_rgba(220,38,38,0.45)] border border-red-500/70 font-semibold'
                      : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs">{server.name}</span>
                    {isActive && <Check className="w-3 h-3 text-white ml-1 shrink-0" />}
                  </div>
                  {server.badge && (
                    <span
                      className={`text-[10px] mt-0.5 px-1 py-0.2 rounded font-mono truncate max-w-full ${
                        isActive
                          ? 'bg-black/30 text-white/90'
                          : 'bg-white/5 text-zinc-400'
                      }`}
                    >
                      {server.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* TV Series Season & Episode Selector (if TV) */}
          {isTv && (
            <div className="pt-2.5 border-t border-white/10 flex flex-col gap-2.5">
              {/* Season Selection */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
                  <Layers className="w-3 h-3 text-amber-400" />
                  Season
                </span>
                <select
                  value={season}
                  onChange={(e) => {
                    setSeason(Number(e.target.value));
                    setEpisode(1);
                  }}
                  className="bg-zinc-900/90 text-zinc-200 border border-white/15 rounded-lg px-2 py-0.5 text-xs focus:outline-none cursor-pointer hover:border-white/30"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => (
                    <option key={s} value={s} className="bg-zinc-900 text-white">
                      Season {s}
                    </option>
                  ))}
                </select>
              </div>

              {/* Episodes Section */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
                    <Tv className="w-3 h-3 text-blue-400" />
                    Episode
                  </span>
                  <span className="text-[10px] text-zinc-400 font-mono">
                    Ep {episode}
                  </span>
                </div>

                {/* Numbered Pills Grid */}
                <div className="grid grid-cols-5 gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                  {Array.from({ length: 30 }, (_, i) => i + 1).map((ep) => {
                    const isEpActive = ep === episode;
                    return (
                      <button
                        key={ep}
                        type="button"
                        onClick={() => setEpisode(ep)}
                        className={`py-1 text-xs font-medium rounded-lg transition-all text-center cursor-pointer ${
                          isEpActive
                            ? 'bg-blue-600 text-white shadow-[0_0_10px_rgba(37,99,235,0.4)] border border-blue-500'
                            : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/5'
                        }`}
                      >
                        {ep}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
