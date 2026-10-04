import pathlib

# ---------------------------------------------------------------------------
# policy.js: the gate answers its own question when it can, instead of bouncing
# the call back to the model
# ---------------------------------------------------------------------------
p = pathlib.Path('server/agent/policy.js')
t = p.read_text()

old = """const refusal = (message, ui) => ({ message, ui });"""
new = """const refusal = (message, ui) => ({ message, ui });

// ---------------------------------------------------------------------------
// Answering the question instead of asking it
// ---------------------------------------------------------------------------

/** Bounds on the automatic look: enough to know what is there, never a full read. */
const AUTO_TREE_DEPTH = 6;
const AUTO_TREE_ENTRIES = 400;
const AUTO_FILES = 6;
const AUTO_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The gate's question is always the same one — "do you actually know what this
 * call is about to remove or replace?" — and a refusal used to send that question
 * back to the model as a failed call, which cost a round trip, showed the user a
 * red row, and was sometimes answered by the model simply trying again.
 *
 * The run can answer it itself: listing the folder and reading the file IS the
 * inspection. This does exactly that, bounded, and reports what it saw in the
 * tool's own result — so the model still learns what it is about to touch, the
 * action stays safe, and nothing is refused that a look would have allowed.
 *
 * @param folders workspace-relative paths ending in "/"
 * @param files   plain file paths
 * @returns a one-line note for the tool result, or null when the look failed
 *          (a huge file, an unreadable tree) — in which case the caller refuses
 *          the way it always did.
 */
async function lookFirst(ws, state, folders, files) {
  const seen = [];
  const led = ledgerOf(state);
  for (const rel of folders.slice(0, 3)) {
    const abs = await resolveIn(ws, rel);
    if (!abs) return null;
    try {
      const { entries, truncated } = await ws.listTree(abs, { depth: AUTO_TREE_DEPTH, maxEntries: AUTO_TREE_ENTRIES });
      observeListing(ws, state, abs, entries, { truncated: false, depth: AUTO_TREE_DEPTH });
      const named = entries.filter((e) => e.type !== 'dir').map((e) => e.path);
      const shown = named.slice(0, 6).join(', ');
      seen.push(
        `listed \`${ws.displayPath(abs)}/\` (${named.length} file${named.length === 1 ? '' : 's'}${
          named.length ? `: ${shown}${named.length > 6 ? ', …' : ''}` : ''
        })${truncated ? ' — the listing was truncated, so part of it is still unseen' : ''}`
      );
      if (truncated) return null;
    } catch {
      return null;
    }
  }
  for (const rel of files.slice(0, AUTO_FILES)) {
    const abs = await resolveIn(ws, rel);
    if (!abs) return null;
    try {
      const st = await ws.stat(abs);
      if (!st?.type) continue; // nothing there: nothing to inspect
      if (st.type === 'dir') continue;
      if (Number.isFinite(st.size) && st.size > AUTO_FILE_BYTES) return null;
      const r = await ws.readText(abs);
      if (r.binary) return null;
      observeFile(state, abs);
      const lines = String(r.text || '').split('\\n');
      const first = (lines.find((l) => l.trim()) || '').trim().slice(0, 80);
      seen.push(`read \`${ws.displayPath(abs)}\` (${lines.length} line${lines.length === 1 ? '' : 's'}${first ? `, starts ${JSON.stringify(first)}` : ''})`);
    } catch {
      return null;
    }
  }
  if (!seen.length) return null;
  // The ledger may have been filled directly; keep it in one place for clarity.
  void led;
  return `Looked first, since this run had not: ${seen.join(' · ')}.`;
}
"""
assert old in t
t = t.replace(old, new, 1)

# --- the removal branch: look, then decide ---------------------------------
old = """  if (name === 'run_command') {
    // A move is a removal's quiet cousin: the file that disappears is replaced
    // by one under a new name, and moving ONTO a file throws that file away.
    // Both halves get the same question the delete path asks.
    const moves = movingTargets(args.command);
    if (moves.length) {
      const needFiles = [];
      const needFolders = [];
      const clobbered = [];
      let rootSource = '';
      for (const { from, to } of moves) {"""
new = """  if (name === 'run_command') {
    // A move is a removal's quiet cousin: the file that disappears is replaced
    // by one under a new name, and moving ONTO a file throws that file away.
    // Both halves get the same question the delete path asks.
    const moves = movingTargets(args.command);
    if (moves.length) {
      const needFiles = [];
      const needFolders = [];
      const clobbered = [];
      let rootSource = '';
      for (const { from, to } of moves) {"""
assert old in t  # unchanged; keeping the anchor explicit

old = """      const ask = [...new Set([...needFolders, ...needFiles, ...clobbered])];
      if (ask.length) {
        return refusal(
          `Refused: nothing was moved. This command renames or replaces something that has not been inspected in this run — ${ask.join(', ')} first, ` +
            `so the file you move is the one you mean and the file you land on is one you have already seen.`,
          { kind: 'command', command: String(args.command || ''), blocked: true }
        );
      }"""
new = """      const ask = [...new Set([...needFolders, ...needFiles, ...clobbered])];
      if (ask.length) {
        // Ask the question, then answer it: the sources and the file it would
        // land on are looked at right here, and the model is told what was seen.
        const note = await lookFirst(
          ws,
          state,
          needFolders.map((p) => p.replace(/^list `|`$/g, '')),
          [...needFiles, ...clobbered].map((p) => p.replace(/^read `|`$/g, ''))
        );
        if (note) {
          const stillUnseen = await unseenMoves();
          if (!stillUnseen.length) return { allow: true, note };
        }
        return refusal(
          `Refused: nothing was moved. This command renames or replaces something that has not been inspected in this run — ${ask.join(', ')} first, ` +
            `so the file you move is the one you mean and the file you land on is one you have already seen.`,
          { kind: 'command', command: String(args.command || ''), blocked: true }
        );
      }"""
assert old in t
t = t.replace(old, new, 1)
p.write_text(t)
print('policy.js: lookFirst added (moves)')
