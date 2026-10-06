import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CornerDownLeft, Search } from 'lucide-react';
import { fuzzyRank } from '../utils/fuzzyMatch';
import { useEscapeToClose, useFocusTrap } from '../utils/useDismissOnOutside';

export interface Command {
  id: string;
  /** What the user reads and what the query is matched against. */
  label: string;
  /** Second line: a chat's last activity, a model's provider, where a file sits. */
  hint?: string;
  /** Section heading; commands keep the order they were given within one. */
  group: string;
  icon?: LucideIcon;
  /** Rendered right-aligned, e.g. ⌘N. Display only — binding lives in App. */
  shortcut?: string;
  /** Extra words that should find this command without being shown. */
  keywords?: string;
  /** Marks the current theme, the open chat, the selected model. */
  active?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
}

/** Wraps the characters the query matched so the user can see why a row is here. */
const Highlighted: React.FC<{ text: string; matched: number[] }> = ({ text, matched }) => {
  if (!matched.length) return <>{text}</>;
  const hit = new Set(matched);
  const parts: React.ReactNode[] = [];
  let run = '';
  let runHit = hit.has(0);
  for (let i = 0; i < text.length; i += 1) {
    const isHit = hit.has(i);
    if (isHit !== runHit) {
      parts.push(runHit
        ? <mark key={i} className="bg-transparent text-zinc-900 dark:text-white font-semibold">{run}</mark>
        : <span key={i}>{run}</span>);
      run = '';
      runHit = isHit;
    }
    run += text[i];
  }
  parts.push(runHit
    ? <mark key="last" className="bg-transparent text-zinc-900 dark:text-white font-semibold">{run}</mark>
    : <span key="last">{run}</span>);
  return <>{parts}</>;
};

/**
 * Ctrl/⌘K: everything the app can do, by name.
 *
 * The point of a palette is that you never have to remember where a thing
 * lives — switching chat, model, workspace and theme are all the same gesture as
 * running a command, so they are all in one list and ranked together.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, commands }) => {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);
  useEscapeToClose(onClose, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setCursor(0);
    // The input must have focus before the first keystroke, and the dialog has
    // only just mounted.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  const results = useMemo(() => {
    const ranked = fuzzyRank(query, commands, (c) => (c.keywords ? `${c.label} ${c.keywords}` : c.label));
    // Keywords help a command be found, but highlighting an index past the end
    // of the visible label would be nonsense.
    return ranked.map((r) => ({ ...r, matched: r.matched.filter((i) => i < r.item.label.length) }));
  }, [query, commands]);

  // Headings are drawn from the result order, so a group only appears when
  // something in it survived the filter.
  const rows = useMemo(() => {
    const out: Array<{ kind: 'group'; name: string } | { kind: 'cmd'; index: number; item: Command; matched: number[] }> = [];
    let last = '';
    results.forEach((r, index) => {
      if (r.item.group !== last) {
        out.push({ kind: 'group', name: r.item.group });
        last = r.item.group;
      }
      out.push({ kind: 'cmd', index, item: r.item, matched: r.matched });
    });
    return out;
  }, [results]);

  useEffect(() => { setCursor(0); }, [query]);

  // Keep the highlighted row on screen when it moves by keyboard.
  useEffect(() => {
    if (!isOpen) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, isOpen, rows.length]);

  if (!isOpen) return null;

  const choose = (cmd: Command) => {
    // Close first: a command that opens another dialog should not have to fight
    // this one for focus.
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Home') {
      e.preventDefault(); setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault(); setCursor(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) choose(hit.item);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh] bg-black/40 backdrop-blur-[2px]"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-200 dark:border-zinc-800 px-3.5">
          <Search size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search commands, chats, models…"
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-controls="command-palette-list"
            aria-activedescendant={results[cursor] ? `command-${results[cursor].item.id}` : undefined}
            className="h-12 w-full bg-transparent text-[14px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none"
          />
        </div>

        <div ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto py-1.5">
          {rows.length === 0 && (
            <p className="px-4 py-8 text-center text-[13px] text-zinc-500">
              Nothing matches “{query}”.
            </p>
          )}
          {rows.map((row) => {
            if (row.kind === 'group') {
              return (
                <div key={`g-${row.name}`} className="px-3.5 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {row.name}
                </div>
              );
            }
            const { item, index, matched } = row;
            const isActive = index === cursor;
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                id={`command-${item.id}`}
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                // Pointer, not click: the row must not be chosen by the release of
                // a click that started somewhere else.
                onPointerDown={(e) => { e.preventDefault(); choose(item); }}
                onPointerMove={() => { if (!isActive) setCursor(index); }}
                className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${
                  isActive ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                }`}
              >
                {Icon && <Icon size={15} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-zinc-700 dark:text-zinc-200">
                    <Highlighted text={item.label} matched={matched} />
                  </span>
                  {item.hint && (
                    <span className="block truncate text-[11.5px] text-zinc-400 dark:text-zinc-500">{item.hint}</span>
                  )}
                </span>
                {item.active && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10">
                    current
                  </span>
                )}
                {item.shortcut && (
                  <kbd className="shrink-0 rounded border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.5 font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                    {item.shortcut}
                  </kbd>
                )}
                {isActive && !item.shortcut && (
                  <CornerDownLeft size={13} className="shrink-0 text-zinc-400" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 px-3.5 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span className="ml-auto tabular-nums">{results.length} {results.length === 1 ? 'result' : 'results'}</span>
        </div>
      </div>
    </div>
  );
};
