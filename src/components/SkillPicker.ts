import { fuzzyRank } from '../utils/fuzzyMatch';

export interface SkillOption {
  key: string;
  name: string;
  description?: string;
  source?: string;
}

/**
 * The `/skill` query currently under the caret, or null.
 *
 * Mirrors the @-mention rule: a slash only starts a skill where a word can
 * start, so a path like `src/App.tsx`, a date, or a closing `</div>` never
 * turns the picker on. The query ends at the first space because skill names
 * are single tokens.
 */
export function skillQueryAt(text: string, caret: number): { query: string; start: number } | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === '/') {
      const before = i >= 2 ? text[i - 2] : '';
      if (before && !/\s/.test(before)) return null; // part of a path, not a command
      return { query: text.slice(i, caret), start: i - 1 };
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Rank skills for a query. A name hit always outranks a description hit — the
 * user typing "debug" means the skill called debugging, not every playbook that
 * mentions the word.
 */
export function rankSkills(query: string, skills: SkillOption[], limit = 8): SkillOption[] {
  const q = query.trim();
  if (!q) return skills.slice(0, limit);
  const byName = fuzzyRank(q, skills, (s) => s.key);
  const hits = new Map<string, { item: SkillOption; score: number }>();
  for (const r of byName) hits.set(r.item.key, { item: r.item, score: r.score + 100 });
  for (const r of fuzzyRank(q, skills, (s) => s.description || '')) {
    if (!hits.has(r.item.key)) hits.set(r.item.key, { item: r.item, score: r.score });
  }
  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.item);
}

/**
 * Replace the `/query` under the caret with the chosen skill, leaving the caret
 * after a trailing space so the user carries on writing the request.
 */
export function applySkill(text: string, start: number, caretEnd: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caretEnd);
  const needsSpace = !rest.startsWith(' ');
  const inserted = `/${name}${needsSpace ? ' ' : ''}`;
  return {
    text: text.slice(0, start) + inserted + rest,
    caret: start + inserted.length,
  };
}
