/**
 * A scripted, OpenAI-compatible chat-completions server for testing Agent mode
 * without any API key — it streams text, reasoning and tool calls (with the
 * arguments split into fragments, like a real provider).
 *
 *   node scripts/fake-llm.js 4010        # then use baseUrl http://127.0.0.1:4010/v1
 *
 * The `model` name picks the scenario: fake-build, fake-slow, fake-fail,
 * fake-approval, fake-silent, fake-bad-calls, fake-loop, fake-bulky, fake-preview, fake-project, fake-burst, fake-batch.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieces = (str, n) => {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out.length ? out : [''];
};

export const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hello</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello, world</h1>
  <p class="lead">A tiny landing page.</p>
  <button id="go">Click me</button>
  <script>
    document.getElementById('go').addEventListener('click', () => alert('Hi!'));
  </script>
</body>
</html>
`;

export const CSS = `body { font-family: system-ui, sans-serif; margin: 2rem; }
h1 { color: #111; }
.lead { color: #555; }
button { padding: .5rem 1rem; }
`;

/** Each scenario: ({ roundIdx, messages }) -> { text?, thinking?, toolCalls?: [{ name, args }], delayMs? } */
export const scenarios = {
  build: ({ roundIdx }) => {
    switch (roundIdx) {
      case 0:
        return {
          thinking: 'The user wants a small page. I will plan, then write two files.',
          text: "I'll set up a small landing page.",
          toolCalls: [
            { name: 'update_plan', args: { todos: [{ content: 'Create the page', status: 'in_progress' }, { content: 'Style it', status: 'pending' }, { content: 'Verify', status: 'pending' }] } },
            { name: 'write_file', args: { path: 'index.html', content: HTML } },
            { name: 'write_file', args: { path: 'style.css', content: CSS } },
          ],
        };
      case 1:
        return {
          text: 'Now a couple of refinements.',
          toolCalls: [
            { name: 'read_file', args: { path: 'index.html', start_line: 1, end_line: 12 } },
            { name: 'multi_edit', args: { path: 'style.css', edits: [{ old_string: 'color: #111;', new_string: 'color: #0a58ca;' }, { old_string: 'padding: .5rem 1rem;', new_string: 'padding: .6rem 1.2rem;\n  border-radius: 8px;' }] } },
            { name: 'edit_file', args: { path: 'index.html', old_string: '<title>Hello</title>', new_string: '<title>Hello — Danav</title>' } },
          ],
        };
      case 2:
        return {
          toolCalls: [
            { name: 'run_command', args: { command: "node -e \"console.log(require('fs').readFileSync('index.html','utf8').split('\\n').length + ' lines')\"" } },
            { name: 'grep_search', args: { pattern: 'Hello' } },
            { name: 'list_dir', args: {} },
          ],
        };
      default:
        return { text: 'Done! I created index.html and style.css, tweaked the styling and verified the page with a command.' };
    }
  },

  slow: ({ roundIdx }) => {
    if (roundIdx === 0) {
      return {
        text: 'Writing the page now.',
        delayMs: 45,
        toolCalls: [{ name: 'write_file', args: { path: 'index.html', content: HTML.repeat(3).replace(/<!DOCTYPE html>/g, '<!-- part -->') } }],
      };
    }
    if (roundIdx === 1) return { toolCalls: [{ name: 'run_command', args: { command: 'echo step-1; sleep 2; echo step-2' } }] };
    return { text: 'All finished.' };
  },

  fail: () => ({
    text: 'Trying to fix it.',
    toolCalls: [{ name: 'edit_file', args: { path: 'missing.js', old_string: 'foo', new_string: 'bar' } }],
  }),

  approval: ({ roundIdx }) =>
    roundIdx === 0
      ? { text: 'Running a command.', toolCalls: [{ name: 'run_command', args: { command: 'echo approved-output' } }] }
      : { text: 'Command finished.' },

  silent: ({ roundIdx, messages }) => {
    if (roundIdx === 0) return { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'hi\n' } }] };
    const nudged = messages.some((m) => m.role === 'user' && String(m.content).includes('finished without a message'));
    return nudged ? { text: 'I created a.txt.' } : { text: '' };
  },

  badCalls: ({ roundIdx }) => {
    if (roundIdx === 0) {
      return {
        toolCalls: [
          { name: 'no_such_tool', args: { x: 1 } },
          { name: 'write_file', rawArgs: '{"path": "broken.txt", "content": "unterminated' },
          { name: 'read_file', args: { path: 'does-not-exist.txt' } },
        ],
      };
    }
    return { text: 'I saw the errors and will stop here.' };
  },

  loop: ({ roundIdx }) => ({
    text: `step ${roundIdx + 1}`,
    toolCalls: [{ name: 'run_command', args: { command: `echo round-${roundIdx}` } }],
  }),

  /** The whole tool call arrives in a single chunk, like Gemini does: there is nothing to stream. */
  burst: ({ roundIdx }) =>
    roundIdx === 0
      ? {
          text: 'Writing a big file.',
          toolCalls: [{ name: 'write_file', fragment: 1e9, args: { path: 'big.js', content: Array.from({ length: 200 }, (_, i) => `console.log(${i + 1});`).join('\n') + '\n' } }],
        }
      : { text: 'Done.' },

  /** Several independent read-only calls in one round. */
  parallel: ({ roundIdx }) =>
    roundIdx === 0
      ? { text: 'Researching four things at once.', toolCalls: ['q1', 'q2', 'q3', 'q4'].map((q) => ({ name: 'web_search', args: { query: q } })) }
      : { text: 'Done researching.' },

  /** A big file whose first write is CUT OFF by the output limit; the model continues with append_file. */
  truncate: ({ roundIdx }) => {
    const part1 = Array.from({ length: 40 }, (_, i) => `const row${i + 1} = ${i + 1};`).join('\n') + '\n';
    const part2 = Array.from({ length: 20 }, (_, i) => `const row${i + 41} = ${i + 41};`).join('\n') + '\n';
    switch (roundIdx) {
      case 0: {
        // the JSON simply stops in the middle of line 41
        const cut = `{"path": "data.js", "content": ${JSON.stringify(part1 + 'const row41 = 4')}`.slice(0, -1);
        return { text: 'Writing a long file.', finishReason: 'length', toolCalls: [{ name: 'write_file', rawArgs: cut }] };
      }
      case 1:
        return { text: 'Continuing where it stopped.', toolCalls: [{ name: 'append_file', args: { path: 'data.js', content: 'const row41 = 41;\n' + part2.split('\n').slice(1).join('\n') } }] };
      default:
        return { text: 'The whole file is written.' };
    }
  },

  /** Analyse a big file in chunks, then change two files with ONE multi_edit. */
  batch: ({ roundIdx }) => {
    const big = Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? `function part${i / 20 + 1}() {` : `  step(${i});`)).join('\n') + '\n';
    switch (roundIdx) {
      case 0:
        return {
          text: 'Creating a script and a stylesheet.',
          toolCalls: [
            { name: 'write_file', args: { path: 'big.js', content: big } },
            { name: 'write_file', args: { path: 'style.css', content: 'body {\n  color: red;\n}\n' } },
          ],
        };
      case 1:
        return {
          text: 'Let me look at the structure first, then only the parts I need.',
          toolCalls: [
            { name: 'file_outline', args: { path: 'big.js' } },
            { name: 'read_file', args: { path: 'big.js', ranges: [[1, 5], [40, 45]] } },
          ],
        };
      case 2:
        return {
          text: 'All the changes in one go.',
          toolCalls: [
            {
              name: 'multi_edit',
              args: {
                edits: [
                  { path: 'big.js', start_line: 3, new_string: '  // changed line 3' },
                  { path: 'big.js', start_line: 50, end_line: 52, new_string: '' },
                  { path: 'big.js', insert_after_line: 60, new_string: 'done();' },
                  { path: 'style.css', old_string: 'color: red', new_string: 'color: blue' },
                ],
              },
            },
          ],
        };
      default:
        return { text: 'Edited both files with a single call.' };
    }
  },

  /** A small project with many file types in nested folders — shows off the file / folder icons. */
  project: ({ roundIdx }) => {
    if (roundIdx > 0) return { text: 'The project is set up — open the Files panel to look around.' };
    const files = {
      'index.html': '<!DOCTYPE html>\n<html>\n<head><link rel="stylesheet" href="css/style.css"></head>\n<body><script src="js/app.js"></script></body>\n</html>\n',
      'css/style.css': 'body { margin: 0; }\n',
      'js/app.js': "console.log('hi');\n",
      'src/components/Button.tsx': 'export const Button = () => <button>OK</button>;\n',
      'src/utils/helpers.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>\n',
      'package.json': '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n',
      'README.md': '# Demo\n',
      '.gitignore': 'node_modules\n',
      'data/items.json': '[1, 2, 3]\n',
      'server/app.py': "print('hello')\n",
      'tests/app.test.js': "test('x', () => {});\n",
      'Dockerfile': 'FROM node:20\n',
      'scripts/build.sh': '#!/bin/sh\necho build\n',
    };
    return {
      text: 'Setting up a small project.',
      toolCalls: Object.entries(files).map(([path, content]) => ({ name: 'write_file', args: { path, content } })),
    };
  },

  /** A web server in the background + its preview link. */
  preview: ({ roundIdx }) => {
    switch (roundIdx) {
      case 0:
        return { text: 'Creating a site to serve.', toolCalls: [{ name: 'write_file', args: { path: 'site/index.html', content: '<h1>PREVIEW OK</h1>\n' } }] };
      case 1:
        return { text: 'Starting the server.', toolCalls: [{ name: 'run_command', args: { command: 'python3 -m http.server 3000 --bind 0.0.0.0', cwd: 'site', background: true } }] };
      case 2:
        return { toolCalls: [{ name: 'get_preview_url', args: { port: 3000 } }] };
      default:
        return { text: 'Your site is live — open the preview link above.' };
    }
  },

  /** Bulky tool results, to exercise context pruning. */
  bulky: ({ roundIdx }) =>
    roundIdx < 6
      ? { toolCalls: [{ name: 'run_command', args: { command: `node -e "console.log('x'.repeat(9000))"` } }] }
      : { text: 'done' },
};

const byModel = {
  'fake-build': scenarios.build,
  'fake-slow': scenarios.slow,
  'fake-fail': scenarios.fail,
  'fake-approval': scenarios.approval,
  'fake-silent': scenarios.silent,
  'fake-bad-calls': scenarios.badCalls,
  'fake-loop': scenarios.loop,
  'fake-bulky': scenarios.bulky,
  'fake-preview': scenarios.preview,
  'fake-project': scenarios.project,
  'fake-burst': scenarios.burst,
  'fake-batch': scenarios.batch,
  'fake-truncate': scenarios.truncate,
  'fake-parallel': scenarios.parallel,
};

export function startFakeLlm({ port = 0, chunkDelayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"not found"}}');
    }
    let raw = '';
    for await (const c of req) raw += c;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end('{"error":{"message":"bad json"}}');
    }
    requests.push(payload);

    if (payload.model === 'fake-http-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"upstream exploded"}}');
    }
    if (payload.model === 'fake-no-tools' && payload.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"tools are not supported by this model"}}');
    }

    const scenario = byModel[payload.model] || scenarios.build;
    const roundIdx = payload.messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const withTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const round = withTools ? scenario({ roundIdx, messages: payload.messages }) : { text: 'Wrapping up without using more tools.' };
    const delay = round.delayMs ?? chunkDelayMs;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish) => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
    const aborted = () => res.destroyed || res.writableEnded;
    req.on('aborted', () => res.destroy());

    write(chunk({ role: 'assistant', content: '' }));
    if (round.thinking) {
      for (const part of pieces(round.thinking, 14)) {
        if (aborted()) return;
        write(chunk({ reasoning_content: part }));
        if (delay) await sleep(delay);
      }
    }
    if (round.text) {
      for (const part of pieces(round.text, 6)) {
        if (aborted()) return;
        write(chunk({ content: part }));
        if (delay) await sleep(delay);
      }
    }
    let i = 0;
    for (const tc of round.toolCalls || []) {
      const id = `call_${roundIdx}_${i}`;
      write(chunk({ tool_calls: [{ index: i, id, type: 'function', function: { name: tc.name, arguments: '' } }] }));
      const argText = tc.rawArgs ?? JSON.stringify(tc.args ?? {});
      for (const frag of pieces(argText, tc.fragment || 28)) {
        if (aborted()) return;
        write(chunk({ tool_calls: [{ index: i, function: { arguments: frag } }] }));
        if (delay) await sleep(delay);
      }
      i++;
    }
    write(chunk({}, round.finishReason ?? (round.toolCalls?.length ? 'tool_calls' : 'stop')));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        server,
        port: p,
        baseUrl: `http://127.0.0.1:${p}/v1`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.argv[2]) || 4010;
  const { baseUrl } = await startFakeLlm({ port, chunkDelayMs: 25 });
  console.log(`Fake LLM listening: ${baseUrl}\nModels: ${Object.keys(byModel).join(', ')}`);
}
