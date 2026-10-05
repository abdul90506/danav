import React from 'react';
import type { SearchSource } from '../types';

interface SearchSourceStackProps {
  sources?: SearchSource[];
  className?: string;
}

const faviconFor = (domain: string) => {
  const url = new URL('https://www.google.com/s2/favicons');
  url.searchParams.set('domain', domain);
  url.searchParams.set('sz', '32');
  return url.toString();
};

/** A small, real-source-only favicon stack for web search rows. */
export const SearchSourceStack: React.FC<SearchSourceStackProps> = ({ sources, className = '' }) => {
  const seen = new Set<string>();
  const safeSources = (sources || []).flatMap((source) => {
    if (!source || typeof source.domain !== 'string') return [];
    try {
      const parsed = new URL(`https://${source.domain}`);
      const domain = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      if (
        parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash ||
        !domain.includes('.') || /^(?:localhost|.*\.localhost|.*\.local)$/.test(domain) || seen.has(domain)
      ) return [];
      seen.add(domain);
      return [{ domain, name: typeof source.name === 'string' ? source.name.trim() : '' }];
    } catch {
      return [];
    }
  }).slice(0, 3);

  if (!safeSources.length) return null;
  const label = safeSources.map((source) => source.name || source.domain).join(', ');

  return (
    <span
      role="img"
      aria-label={`Search sources: ${label}`}
      data-testid="search-source-stack"
      className={`inline-flex shrink-0 items-center pl-0.5 align-middle ${className}`}
    >
      {safeSources.map((source, index) => (
        <span
          key={source.domain}
          title={source.name ? `${source.name} · ${source.domain}` : source.domain}
          className={`relative inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/90 bg-zinc-100 text-[8px] font-semibold uppercase leading-none text-zinc-500 shadow-[0_0_0_1px_rgba(113,113,122,0.12)] dark:border-zinc-950 dark:bg-zinc-800 dark:text-zinc-300 ${index ? '-ml-1.5' : ''}`}
          style={{ zIndex: safeSources.length - index, opacity: index === 0 ? 1 : 0.72 + (safeSources.length - index) * 0.06 }}
        >
          <span aria-hidden="true">{source.domain.charAt(0)}</span>
          <img
            src={faviconFor(source.domain)}
            alt=""
            aria-hidden="true"
            loading="lazy"
            className="absolute inset-0 h-full w-full bg-white object-contain p-[2px] dark:bg-zinc-900"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        </span>
      ))}
    </span>
  );
};
