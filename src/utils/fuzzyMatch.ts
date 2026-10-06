/**
 * Subsequence scoring for the command palette.
 *
 * The palette is judged entirely on its first three keystrokes, so the ranking
 * matters more than the matching: "nc" has to put "New chat" above "Sandbox
 * manager", even though both contain an n and a c. Scoring rewards the things a
 * person is actually doing when they type an abbreviation — hitting the start of
 * a word, typing letters that run together, getting the whole query in early —
 * rather than just confirming the letters appear somewhere.
 */

export interface FuzzyResult {
  /** Higher is better. */
  score: number;
  /** Indices in the haystack that the query matched, for highlighting. */
  matched: number[];
}

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.') return true;
  // camelCase: a capital after a lowercase starts a new word.
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && prev !== cur;
};

/**
 * Score `query` against `text`. Returns null when the query is not a
 * subsequence of the text, which is the only hard requirement — everything else
 * is ranking.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.trim();
  if (!q) return { score: 0, matched: [] };
  if (q.length > text.length) return null;

  const lowerQ = q.toLowerCase();
  const lowerT = text.toLowerCase();
  const lengthPenalty = Math.min((text.length - lowerQ.length) / 4, 15); // shorter names win ties

  // Two readings of the same query, scored against each other rather than one
  // short-circuiting the other. "ab" is a literal substring of "alphaBeta" once
  // both are lowercased, but what the user meant was alpha + Beta, and only
  // comparing the two candidates gets that right.
  let best: FuzzyResult | null = null;
  const consider = (candidate: FuzzyResult) => {
    if (!best || candidate.score > best.score) best = candidate;
  };

  const direct = lowerT.indexOf(lowerQ);
  if (direct !== -1) {
    const matched = Array.from({ length: lowerQ.length }, (_, i) => direct + i);
    // A run of letters starting mid-word is a much weaker signal than one
    // starting where a word does, so the base reflects that rather than a bonus.
    let score = (direct === 0 ? 190 : isBoundary(text, direct) ? 165 : 70) + lowerQ.length * 8;
    score -= Math.min(direct, 20); // later in the string is weaker
    score -= lengthPenalty;
    consider({ score, matched });
  }

  let score = 0;
  let ti = 0;
  let runLength = 0;
  const matched: number[] = [];

  for (let qi = 0; qi < lowerQ.length; qi += 1) {
    const ch = lowerQ[qi];
    // Prefer the next boundary occurrence over the next occurrence at all:
    // "nc" should match the N and the C that start the two words of "New chat".
    let at = -1;
    for (let k = ti; k < lowerT.length; k += 1) {
      if (lowerT[k] !== ch) continue;
      if (at === -1) at = k;
      if (isBoundary(text, k)) { at = k; break; }
    }
    if (at === -1) return best;

    if (isBoundary(text, at)) score += 30;
    else score += 4;
    if (at === ti && qi > 0) { runLength += 1; score += 10 + runLength * 4; }
    else runLength = 0;
    score -= Math.min((at - ti) / 2, 8); // every skipped character is weaker evidence

    matched.push(at);
    ti = at + 1;
  }

  // Every letter landed where a word starts: this is someone typing initials
  // ("nc" for New chat, "ab" for alphaBeta), the single strongest signal the
  // palette gets, and the one thing that should outrank a mid-word substring.
  if (matched.every((i) => isBoundary(text, i))) score += 80 + lowerQ.length * 10;

  score -= lengthPenalty;
  consider({ score, matched });
  return best;
}

/**
 * Rank `items` against a query, dropping the ones that do not match at all.
 * Ties keep the caller's order, which is how a sensible default list survives an
 * empty query.
 */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  keyOf: (item: T) => string,
): Array<{ item: T; score: number; matched: number[] }> {
  const q = query.trim();
  const out: Array<{ item: T; score: number; matched: number[]; order: number }> = [];
  items.forEach((item, order) => {
    const hit = fuzzyMatch(q, keyOf(item));
    if (hit) out.push({ item, score: hit.score, matched: hit.matched, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ item, score, matched }) => ({ item, score, matched }));
}
