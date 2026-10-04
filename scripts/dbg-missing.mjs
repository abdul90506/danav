import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../server/agent/workspaces/local.js';
import { buildToolset } from '../server/agent/tools.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-miss-'));
const ws = new LocalWorkspace({ id: 'x', kind: 'local', name: 'x', root, autoRun: true });
await ws.init();
for (const f of ['app.js', 'src/app.js', 'notes.txt']) { await ws.writeText(await ws.resolve(f), 'x\n'); }
const tools = buildToolset({ workspace: ws, redact: (s) => s });
const ctx = { state: { readFiles: new Set(), plan: [] }, emit() {}, signal: undefined, workspace: ws };
for (const [name, args] of [
  ['read_file', { path: 'app.ts' }],
  ['read_file', { path: 'src/app.ts' }],
  ['read_file', { path: 'src' }],
  ['list_dir', { path: 'sr' }],
  ['edit_file', { path: 'notes.tx', old_string: 'x', new_string: 'y' }],
  ['run_command', { command: 'sleep 2', timeout: 1 }],
  ['grep_search', { pattern: '([' }],
]) {
  const r = await tools.execute(name, args, ctx);
  console.log(`${name} ${JSON.stringify(args).slice(0, 40)} → ${String(r.output || r.error).split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300)}`);
}
process.exit(0);
