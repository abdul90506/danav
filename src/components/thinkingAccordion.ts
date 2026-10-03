/**
 * Which thinking block is open — one, for the whole chat.
 *
 * Expanding a thought collapses whichever other one was open, wherever it lives
 * in the transcript. This lives outside React (a tiny subscribable store) so a
 * ThinkingSection inside any message can take part without the whole chat having
 * to re-render every time a thought opens or closes.
 */

let openId: string | null = null;
const listeners = new Set<() => void>();

export function getOpenThinkingId(): string | null {
  return openId;
}

export function setOpenThinkingId(id: string | null): void {
  if (openId === id) return;
  openId = id;
  for (const listener of listeners) listener();
}

export function subscribeThinkingAccordion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
