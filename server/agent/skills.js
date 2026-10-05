/**
 * Progressive-disclosure project skills.
 *
 * A skill is inert Markdown in a well-known project folder, never executable
 * plugin code. Only a tiny name/description catalog enters the system prompt;
 * the complete playbook is returned through load_skill only when it fits the
 * current task. Every path stays inside the workspace and project text remains
 * untrusted data.
 */

import { looksLikeSecret } from './memory.js';
import { BUILTIN_SKILLS } from './builtinSkills.js';

const SKILL_ROOTS = ['.danav/skills', '.agents/skills', '.claude/skills', '.cursor/skills'];
const MAX_SKILLS = 26;
const MAX_SKILL_BYTES = 48_000;
const MAX_DISCOVERY_BYTES = 480_000;
const MAX_SKILL_CHARS = 16_000;
const MAX_DISCOVERY_ATTEMPTS = 2;
const EXPECTED_SCAN_ERRORS = new Set(['not_found', 'not_dir', 'is_dir', 'outside_workspace', 'denied', 'too_large']);
const MAX_DESCRIPTION_CHARS = 180;

const oneLine = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const safeName = (value, fallback) => {
  const text = oneLine(value, 80);
  return /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(text) ? text : fallback;
};

function parseFrontmatter(text, fallbackName) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(source);
  const fields = {};
  let body = source;
  if (match) {
    body = source.slice(match[0].length);
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const field = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
      if (!field) continue;
      const key = field[1].toLowerCase();
      let value = field[2].trim();
      if (value === '>' || value === '|') {
        const parts = [];
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
          parts.push(lines[j].trim());
          i = j;
        }
        value = parts.join(value === '>' ? ' ' : '\n');
      } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'name' || key === 'description') fields[key] = value;
    }
  }

  const name = safeName(fields.name, fallbackName);
  const firstParagraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#')) || '';
  const description = oneLine(fields.description || firstParagraph, MAX_DESCRIPTION_CHARS) || 'Project-specific instructions for a matching task.';
  return { name, description, body: body.trim() };
}

const relativeSkillPath = (root, entryPath) => `${root}/${String(entryPath || '').replace(/\\/g, '/')}`;

export function createSkillRegistry(workspace, redact = (text) => text) {
  let discovered = false;
  let discoveryAttempts = 0;
  let catalog = [];

  const safePath = async (relative) => typeof workspace.safePath === 'function'
    ? workspace.safePath(relative)
    : workspace.resolve(relative);

  async function discover(workspaceListing) {
    if (discovered || discoveryAttempts >= MAX_DISCOVERY_ATTEMPTS) return catalog.map(({ key, name, description, path, source }) => ({ key, name, description, path, source }));
    discoveryAttempts++;
    let incomplete = false;
    const candidates = BUILTIN_SKILLS.map((skill) => ({ ...skill, size: skill.body.length }));
    let inspectedBytes = 0;
    const visibleRootDirs = workspaceListing && !workspaceListing.truncated && Array.isArray(workspaceListing.entries)
      ? new Set(workspaceListing.entries.filter((entry) => entry.type === 'dir').map((entry) => String(entry.path || '').split('/')[0]))
      : null;

    for (const root of SKILL_ROOTS) {
      if (candidates.length >= MAX_SKILLS || inspectedBytes >= MAX_DISCOVERY_BYTES) break;
      if (visibleRootDirs && !visibleRootDirs.has(root.split('/')[0])) continue;
      try {
        const rootAbs = await safePath(root);
        const listing = await workspace.listTree(rootAbs, { depth: 2, maxEntries: 300 });
        if (!listing || !Array.isArray(listing.entries)) {
          incomplete = true;
          continue;
        }
        for (const entry of listing.entries) {
          const entryPath = String(entry.path || '').replace(/\\/g, '/');
          // The standard is <skill-name>/SKILL.md. Do not crawl arbitrary
          // nested folders or vendor trees looking for files called SKILL.md.
          if (entry.type !== 'file' || !/^[^/]+\/SKILL\.md$/i.test(entryPath)) continue;
          if (candidates.length >= MAX_SKILLS || inspectedBytes >= MAX_DISCOVERY_BYTES) break;
          const relative = relativeSkillPath(root, entryPath);
          try {
            const abs = await safePath(relative);
            const listedSize = Number(entry.size);
            const size = Number.isFinite(listedSize) ? listedSize : (await workspace.stat(abs)).size;
            if (size <= 0 || size > MAX_SKILL_BYTES) continue;
            inspectedBytes += size;
            const read = await workspace.readText(abs, { maxBytes: MAX_SKILL_BYTES });
            if (read.binary) continue;
            const text = String(redact(read.text || ''));
            if (!text.trim() || looksLikeSecret(text)) continue;
            const fallback = entryPath.slice(0, -'/SKILL.md'.length);
            const parsed = parseFrontmatter(text, fallback);
            candidates.push({ ...parsed, path: relative, source: root, size });
          } catch (err) {
            // A bad link, missing/oversize file, or secret cannot block the run.
            // A transient workspace read failure gets one bounded discovery retry.
            if (!EXPECTED_SCAN_ERRORS.has(String(err?.code || ''))) incomplete = true;
          }
        }
      } catch (err) {
        // Skill folders are optional; an unavailable root is not a run failure.
        // Do not cache a transient scan failure as an empty skill catalogue.
        if (!EXPECTED_SCAN_ERRORS.has(String(err?.code || ''))) incomplete = true;
      }
    }

    // Keep duplicate names addressable instead of silently hiding one provider's
    // playbook. The prompt shows the source in the disambiguated handle.
    const counts = new Map();
    for (const item of candidates) counts.set(item.name.toLocaleLowerCase(), (counts.get(item.name.toLocaleLowerCase()) || 0) + 1);
    catalog = candidates.map((item) => ({
      ...item,
      key: counts.get(item.name.toLocaleLowerCase()) > 1 ? `${item.name} [${item.source}]` : item.name,
    }));
    if (incomplete && discoveryAttempts < MAX_DISCOVERY_ATTEMPTS) return discover(workspaceListing);
    discovered = true;
    return catalog.map(({ key, name, description, path, source }) => ({ key, name, description, path, source }));
  }

  async function load(requestedName) {
    const items = await discover();
    const needle = oneLine(requestedName, 120).toLocaleLowerCase();
    if (!needle) throw new Error('Give the skill name shown in the available-skill list.');
    let matches = catalog.filter((item) => item.key.toLocaleLowerCase() === needle);
    if (!matches.length) matches = catalog.filter((item) => item.name.toLocaleLowerCase() === needle);
    if (matches.length > 1) throw new Error(`That skill name is ambiguous. Use one of these exact names: ${matches.map((item) => item.key).join(', ')}.`);
    const item = matches[0];
    if (!item) {
      const choices = items.slice(0, 12).map((skill) => skill.key);
      throw new Error(choices.length
        ? `No project skill named "${oneLine(requestedName, 80)}". Available: ${choices.join(', ')}.`
        : 'No project skills were found. Skills are Markdown playbooks in .danav/skills, .agents/skills, .claude/skills, or .cursor/skills.');
    }

    if (item.bundled) {
      const body = String(redact(item.body || ''));
      if (!body.trim() || looksLikeSecret(body)) throw new Error(`Built-in skill "${item.key}" could not be loaded safely.`);
      return { key: item.key, name: item.name, description: item.description, path: item.path, source: item.source, body };
    }

    const abs = await safePath(item.path);
    const stat = await workspace.stat(abs);
    if (stat.type !== 'file' || stat.size > MAX_SKILL_BYTES) throw new Error(`Skill "${item.key}" changed or is too large to load; re-discover the skill before using it.`);
    const read = await workspace.readText(abs, { maxBytes: MAX_SKILL_BYTES });
    if (read.binary) throw new Error(`Skill "${item.key}" is not readable text.`);
    const text = String(redact(read.text || ''));
    if (looksLikeSecret(text)) throw new Error(`Skill "${item.key}" contains a value that looks like a secret and was not loaded.`);
    const parsed = parseFrontmatter(text, item.name);
    if (!parsed.body) throw new Error(`Skill "${item.key}" has no instructions after its metadata.`);
    if (parsed.body.length > MAX_SKILL_CHARS) {
      const marker = `\n\n[… skill instructions truncated; load the relevant section from ${item.path} if needed …]\n\n`;
      const contentBudget = Math.max(0, MAX_SKILL_CHARS - marker.length);
      const head = Math.ceil(contentBudget * 0.72);
      const tail = contentBudget - head;
      parsed.body = `${parsed.body.slice(0, head)}${marker}${tail ? parsed.body.slice(-tail) : ''}`;
    }
    return { key: item.key, name: parsed.name, description: item.description, path: item.path, source: item.source, body: parsed.body };
  }

  function promptText() {
    if (!catalog.length) return '';
    const lines = [];
    let used = 0;
    for (const item of catalog) {
      const line = `- ${JSON.stringify(item.key)} — ${item.description} (${item.path})`;
      if (used + line.length + (lines.length ? 1 : 0) > 5_000) break;
      lines.push(line);
      used += line.length + (lines.length > 1 ? 1 : 0);
    }
    return lines.join('\n');
  }

  return {
    discover,
    load,
    promptText,
    list: () => catalog.map(({ key, name, description, path, source }) => ({ key, name, description, path, source })),
  };
}
