/**
 * Which thinking block is open — one, for the whole chat.
 *
 * Expanding a thought collapses whichever other one was open, wherever it lives
 * in the transcript. This lives outside React (a tiny subscribable store) so a
 * ThinkingSection inside any message can take part without the whole chat having
 * to re-render every time a thought opens or closes.
 */
import { createPanelStore } from './panels';

const store = createPanelStore();

export function getOpenThinkingId(): string | null {
  return store.get();
}

export function setOpenThinkingId(id: string | null): void {
  store.set(id);
}

export function subscribeThinkingAccordion(listener: () => void): () => void {
  return store.subscribe(listener);
}
