import { fuzzyRank } from '../utils/fuzzyMatch';

/**
 * The @-mention query currently under the caret, or null.
 *
 * A mention only starts where a word can start — the beginning of the line or
 * after whitespace — so an email address or a decorator in pasted code does not
 * turn the picker on. It ends at the first space, because a path with a space in
 * it is rare enough that the alternative (never being able to type a space
 * again) is the worse trade.
 */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk back from the caret to the @, refusing anything that cannot be in a path.
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === '@') {
      const before = i >= 2 ? text[i - 2] : '';
      if (before && !/\s/.test(before)) return null; // foo@bar is an address, not a mention
      return { query: text.slice(i, caret), start: i - 1 };
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/** Rank workspace paths for a mention query. Basename hits outrank folder hits. */
export function rankMentions(query: string, files: string[], limit = 8): Array<{ path: string; matched: number[] }> {
  const q = query.trim();
  if (!q) {
    // No query yet: show something useful rather than whatever the filesystem
    // happened to return first. Shallow files are the ones people mean.
    return [...files]
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, limit)
      .map((path) => ({ path, matched: [] }));
  }

  const ranked = fuzzyRank(q, files, (f) => f);
  // "input" should find ChatInput.tsx before src/services/inputHelpers/index.ts:
  // what people type is almost always the file's own name.
  const scored = ranked.map((r) => {
    const base = r.item.slice(r.item.lastIndexOf('/') + 1);
    const inBase = r.matched.every((i) => i >= r.item.length - base.length);
    return { ...r, score: r.score + (inBase ? 60 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => ({ path: r.item, matched: r.matched }));
}

/**
 * Replace the `@query` under the caret with the chosen path.
 * Returns the new text and where the caret should land, which is after the
 * trailing space so the user keeps typing their sentence.
 */
export function applyMention(text: string, start: number, caretEnd: number, path: string): { text: string; caret: number } {
  const rest = text.slice(caretEnd);
  // Only add the separating space if there is not already one there — picking a
  // file in the middle of a sentence should not leave a double space behind.
  const insert = `@${path}${/^\s/.test(rest) ? '' : ' '}`;
  return {
    text: text.slice(0, start) + insert + rest,
    caret: start + insert.length + (/^\s/.test(rest) ? 1 : 0),
  };
}
