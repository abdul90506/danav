import { useSyncExternalStore } from 'react';

/**
 * One open panel per kind, for the whole chat.
 *
 * A transcript can hold dozens of expandable things — a thought, an action row's
 * detail, a web-tool's raw output. Letting each of them keep its own boolean
 * leaves the user with a screen full of half-open boxes and no way to tidy it:
 * the rule the interface wants is "the one I just opened, and nothing else".
 *
 * This is that rule, as a tiny subscribable store outside React, so the chat
 * itself does not have to re-render when a panel opens: only the panels that are
 * watching it do.
 */
export interface PanelStore {
  get(): string | null;
  set(id: string | null): void;
  close(): void;
  subscribe(listener: () => void): () => void;
}

export function createPanelStore(): PanelStore {
  let openId: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => openId,
    set: (id) => {
      if (openId === id) return;
      openId = id;
      emit();
    },
    close: () => {
      if (openId === null) return;
      openId = null;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** `isOpen` for one panel id; the whole store re-renders only its subscribers. */
export function usePanelOpen(store: PanelStore, id: string): boolean {
  return useSyncExternalStore(store.subscribe, store.get) === id;
}
