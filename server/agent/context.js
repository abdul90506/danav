/** Workspace context discovery: small, safe IDE/project instruction files only. */

const MAX_GUIDANCE_FILES = 20;
const MAX_GUIDANCE_CHARS = 9000;
const MAX_GUIDANCE_FILE_BYTES = 40_000;

const FIXED_GUIDANCE = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
];

function isGuidancePath(value) {
  const p = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const base = p.slice(p.lastIndexOf('/') + 1);
  return (
    base === 'AGENTS.md' ||
    base === 'CLAUDE.md' ||
    p === '.cursorrules' ||
    p === '.windsurfrules' ||
    p === '.github/copilot-instructions.md' ||
    (p.startsWith('.cursor/rules/') && base.endsWith('.mdc')) ||
    (p.startsWith('.github/instructions/') && base.endsWith('.instructions.md'))
  );
}

/**
 * Load a bounded set of common project/IDE rules. No arbitrary config, secrets,
 * or source files are read here. Local workspaces use safePath to reject links
 * that escape the project root.
 */
export async function collectProjectGuidance(workspace, redact = (s) => s) {
  const candidates = new Set(FIXED_GUIDANCE);

  // Nested AGENTS.md applies to code in its subtree, as in common coding agents.
  try {
    const found = await workspace.findFiles({ pattern: 'AGENTS.md', path: workspace.root, maxResults: 80 });
    for (const p of found.files || []) if (isGuidancePath(p)) candidates.add(p);
  } catch {
    /* a missing/unreadable index must not stop the run */
  }

  // Cursor and GitHub Copilot keep rule files in these well-known folders.
  for (const [folder, suffix] of [['.cursor/rules', '.mdc'], ['.github/instructions', '.instructions.md']]) {
    try {
      const dir = typeof workspace.safePath === 'function' ? await workspace.safePath(folder) : workspace.resolve(folder);
      if ((await workspace.stat(dir)).type !== 'dir') continue;
      const listing = await workspace.listTree(dir, { depth: 3, maxEntries: 100 });
      for (const entry of listing.entries || []) {
        const rel = `${folder}/${entry.path}`;
        if (entry.type === 'file' && rel.endsWith(suffix) && isGuidancePath(rel)) candidates.add(rel);
      }
    } catch {
      /* folders are optional */
    }
  }

  const chunks = [];
  let used = 0;
  for (const relative of candidates) {
    if (chunks.length >= MAX_GUIDANCE_FILES || used >= MAX_GUIDANCE_CHARS) break;
    if (!isGuidancePath(relative)) continue;
    try {
      const abs = typeof workspace.safePath === 'function' ? await workspace.safePath(relative) : workspace.resolve(relative);
      const stat = await workspace.stat(abs);
      if (stat.type !== 'file' || stat.size > MAX_GUIDANCE_FILE_BYTES) continue;
      const read = await workspace.readText(abs, { maxBytes: MAX_GUIDANCE_FILE_BYTES });
      if (read.binary) continue;
      const remaining = MAX_GUIDANCE_CHARS - used;
      const clean = String(redact(read.text || '')).trim();
      if (!clean) continue;
      const body = clean.length > remaining - relative.length - 16
        ? `${clean.slice(0, Math.max(0, remaining - relative.length - 32))}\n[truncated — read the full file if relevant]`
        : clean;
      if (!body.trim()) break;
      const chunk = `--- ${relative} ---\n${body}`;
      chunks.push(chunk);
      used += chunk.length + 2;
    } catch {
      /* broken links, missing files, and unreadable optional rules are skipped */
    }
  }
  return chunks.join('\n\n');
}
