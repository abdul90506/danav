/**
 * Frontend logic (TypeScript compiled on the fly with esbuild):
 * the chronological block state-machine, the wording of every action row, and
 * the whole data path SSE → blocks against the REAL backend + a scripted fake LLM.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { startFakeLlm } from '../fake-llm.js';
import { registerAgentRoutes } from '../../server/agent/routes.js';
import { _resetStoreCache } from '../../server/agent/store.js';

const { test } = globalThis.__agentTest;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

console.log('\n[frontend logic]');

async function load(entry) {
  const out = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/**
 * Same as `load`, but keeps React external and writes the bundle to a real file
 * so bare `react` imports resolve to the SAME copy this test file imported.
 * Two React copies would break hooks, which is exactly what we are testing.
 *
 * `lucide-react` is aliased to its ESM build on purpose: its CJS bundle calls
 * `require('react')` dynamically, which esbuild cannot express in an ESM output
 * ("Dynamic require of \"react\" is not supported"). The ESM build imports React
 * normally, so it stays external and shares the single copy.
 */
const LUCIDE_ESM = path.join(root, 'node_modules/lucide-react/dist/esm/lucide-react.mjs');

async function loadComponent(entry) {
  const outFile = path.join(root, `.tmp-test-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'silent',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    alias: { 'lucide-react': LUCIDE_ESM },
  });
  try {
    return await import(pathToFileURL(outFile).href);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

const { AgentTurnState } = await load('src/agent/turnState.ts');
const fmt = await load('src/agent/format.ts');
const icons = await load('src/agent/fileIcons.ts');
const accordion = await load('src/components/thinkingAccordion.ts');
const content = await load('src/utils/messageContent.ts');
const api = await load('src/services/api.ts');

// ---------------------------------------------------------------------------
console.log('\nAttachment budget');
// ---------------------------------------------------------------------------

test('a message carries a bounded payload, and says so when a file does not fit', async () => {
  const budget = await load('src/utils/attachmentBudget.ts');
  assert.equal(budget.totalPayloadBytes([{ content: 'abc' }, { content: 'de' }]), 5);
  assert.equal(budget.totalPayloadBytes([]), 0);

  assert.equal(budget.fitsAttachmentBudget(0, budget.ATTACHMENT_BUDGET_BYTES), true);
  assert.equal(budget.fitsAttachmentBudget(0, budget.ATTACHMENT_BUDGET_BYTES + 1), false);
  // An image data URL is the payload: it must count like any other content.
  const half = budget.ATTACHMENT_BUDGET_BYTES / 2;
  assert.equal(budget.fitsAttachmentBudget(half, half), true);
  assert.equal(budget.fitsAttachmentBudget(half, half + 1), false);

  assert.equal(budget.formatBytesAsMegabytes(15 * 1024 * 1024), '16 MB');
  assert.equal(budget.formatBytesAsMegabytes(budget.ATTACHMENT_BUDGET_BYTES), '12 MB');
  // The composer's budget has to leave room under the server's body limit.
  assert.ok(budget.ATTACHMENT_BUDGET_BYTES < 25 * 1_000_000);
});

// ---------------------------------------------------------------------------
console.log('\nChat titles');
// ---------------------------------------------------------------------------

test('a title from the model is trimmed to something the sidebar can show', () => {
  assert.equal(api.sanitizeChatTitle('Deploying A Vite App'), 'Deploying A Vite App');
  assert.equal(api.sanitizeChatTitle('  "Quoted Title"  '), 'Quoted Title');
  assert.equal(api.sanitizeChatTitle('Two\nlines\there'), 'Two lines here');
  const long = api.sanitizeChatTitle('x'.repeat(400));
  assert.ok(long.length <= 61, `got ${long.length} chars`);
  assert.ok(long.endsWith('…'));
});

test('an unusable title is empty, so the local one is kept', () => {
  assert.equal(api.sanitizeChatTitle(''), '');
  assert.equal(api.sanitizeChatTitle('   \n  '), '');
  assert.equal(api.sanitizeChatTitle(null), '');
  assert.equal(api.sanitizeChatTitle({ title: 'nope' }), '');
  assert.equal(api.sanitizeChatTitle(42), '');
});

// ---------------------------------------------------------------------------
console.log('\nMessage content (text vs images)');
// ---------------------------------------------------------------------------

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

test('a message with no images stays a plain string', () => {
  assert.equal(content.buildMessageContent('hello'), 'hello');
  assert.equal(content.buildMessageContent('hello', []), 'hello');
  // A text file is not an image: it must not turn the content into parts.
  const fileOnly = content.buildMessageContent('hello', [
    { id: 'f1', name: 'a.txt', type: 'file', size: 3, content: 'abc' },
  ]);
  assert.equal(fileOnly, 'hello');
});

test('an attached image becomes a real image part the model can see', () => {
  const parts = content.buildMessageContent('what is this?', [
    { id: 'i1', name: 'shot.png', type: 'image', size: 12, content: IMG },
  ]);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' });
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: IMG } });
});

test('an image with no words still carries a text part', () => {
  // Providers reject an empty content array, so a bare image gets a prompt.
  const parts = content.buildMessageContent('   ', [
    { id: 'i1', name: 'shot.png', type: 'image', size: 12, content: IMG },
  ]);
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
});

test('a broken or missing image payload never becomes an image part', () => {
  const cases = [
    { id: 'i1', name: 'x.png', type: 'image', size: 1, content: '' },
    { id: 'i2', name: 'y.png', type: 'image', size: 1, content: 'https://example.com/y.png' },
    { id: 'i3', name: 'z.png', type: 'image', size: 1 },
  ];
  assert.equal(content.buildMessageContent('hi', cases), 'hi');
  assert.deepEqual(content.imageDataUrls(cases), []);
});

test('several images keep their order after the text part', () => {
  const a = `${IMG}a`;
  const b = `${IMG}b`;
  const parts = content.buildMessageContent('compare', [
    { id: '1', name: 'a.png', type: 'image', size: 1, content: a },
    { id: '2', name: 'b.png', type: 'image', size: 1, content: b },
  ]);
  assert.deepEqual(
    parts.map((p) => (p.type === 'image_url' ? p.image_url.url : p.text)),
    ['compare', a, b]
  );
});

// ---------------------------------------------------------------------------
console.log('\nPreview action wiring');
// ---------------------------------------------------------------------------

/** A finished agent turn whose only step produced a preview URL. */
const previewTurnMessage = () => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  createdAt: 1,
  agent: true,
  blocks: [
    {
      id: 'a1',
      type: 'action',
      action: {
        id: 'a1',
        tool: 'get_preview_url',
        status: 'done',
        args: { port: 5174 },
        result: {
          kind: 'preview',
          port: 5174,
          url: 'https://5174-demo.sandbox.novita.ai',
          title: 'Todo',
        },
      },
    },
  ],
});

test('a preview row grows a "Preview" button that opens the docked panel', async () => {
  const ui = await loadComponent('src/components/ChatArea.tsx');

  const html = renderToStaticMarkup(
    React.createElement(ui.ChatArea, {
      messages: [previewTurnMessage()],
      isLoading: false,
      onOpenPreview: () => {},
    })
  );
  assert.match(html, /data-testid="open-preview-panel"/, 'the Preview button rendered');
  assert.match(html, /Preview/, 'it is labelled Preview');
  // The plain link stays available for opening in a real tab.
  assert.match(html, /https:\/\/5174-demo\.sandbox\.novita\.ai/);
});

test('the preview button is absent when no handler is wired through', async () => {
  // This is the regression: ChatArea received onOpenPreview but never passed it
  // to ChatMessage, so the button silently never rendered.
  const ui = await loadComponent('src/components/ChatArea.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ui.ChatArea, { messages: [previewTurnMessage()], isLoading: false })
  );
  assert.doesNotMatch(html, /data-testid="open-preview-panel"/);
});

// ---------------------------------------------------------------------------
console.log('\nPreview links and the resizable dock');
// ---------------------------------------------------------------------------

test('a preview link is recognised by its host, not by its wording', async () => {
  const { isPreviewUrl, previewHost } = await load('src/utils/previewUrl.ts');
  // The model prints the URL as text far more often than it calls the tool, so
  // these hosts are the whole reason the link works at all.
  assert.equal(isPreviewUrl('https://5174-abc123.us-phx-1.sandbox.novita.ai'), true);
  assert.equal(isPreviewUrl('https://random-words.trycloudflare.com'), true);
  assert.equal(isPreviewUrl('https://abc.ngrok-free.app'), true);
  assert.equal(isPreviewUrl('http://localhost:3000'), false, 'loopback needs the opt-in');
  assert.equal(isPreviewUrl('http://localhost:3000', { allowLoopback: true }), true);
  // Ordinary links must stay ordinary links.
  assert.equal(isPreviewUrl('https://example.com/article'), false);
  assert.equal(isPreviewUrl('https://github.com/foo/bar'), false);
  assert.equal(isPreviewUrl('mailto:someone@example.com'), false);
  assert.equal(isPreviewUrl(''), false);
  assert.equal(isPreviewUrl(undefined), false);
  assert.equal(previewHost('https://5174-abc.sandbox.novita.ai/app?x=1'), '5174-abc.sandbox.novita.ai');
});

test('the docked panel can be dragged, but never past a usable split', async () => {
  const { clampPreviewWidth, defaultPreviewWidth, MIN_PREVIEW_WIDTH, MIN_CHAT_WIDTH } = await loadComponent('src/components/PreviewPanel.tsx');
  // A wide screen: the panel may take most of it, but the chat keeps its minimum.
  assert.equal(clampPreviewWidth(900, 1600), 900);
  assert.equal(clampPreviewWidth(1600 - MIN_CHAT_WIDTH + 200, 1600), 1600 - MIN_CHAT_WIDTH, 'the chat cannot be squeezed away');
  assert.equal(clampPreviewWidth(50, 1600), MIN_PREVIEW_WIDTH, 'and the panel cannot be collapsed to nothing');
  // A narrow screen: the minimum wins over a negative maximum, so nothing breaks.
  assert.equal(clampPreviewWidth(400, 500), MIN_PREVIEW_WIDTH);
  assert.ok(defaultPreviewWidth(1600) > 0 && defaultPreviewWidth(1600) <= 1600 - MIN_CHAT_WIDTH);
});

test('the divider follows the pointer: left is wider, right is narrower', async () => {
  const { dragWidth, clampPreviewWidth, MIN_PREVIEW_WIDTH } = await loadComponent('src/components/PreviewPanel.tsx');
  // The edge is grabbed at x=1000 with the panel 640 wide.
  assert.equal(dragWidth(640, 1000, 1000, 1600), 640, 'no movement, no change');
  assert.equal(dragWidth(640, 1000, 800, 1600), 840, 'moving left by 200 widens by 200');
  assert.equal(dragWidth(640, 1000, 1200, 1600), 440, 'moving right by 200 narrows by 200');
  // It tracks one-for-one, with no acceleration and no dead zone.
  for (const dx of [-300, -140, -37, -1, 0, 1, 37, 140, 300]) {
    assert.equal(dragWidth(640, 1000, 1000 + dx, 1600), 640 - dx, `dx=${dx} is 1:1`);
  }
  // And it still respects the same limits as every other route to a width.
  assert.equal(dragWidth(640, 1000, 1000 - 5000, 1600), clampPreviewWidth(5640, 1600));
  assert.equal(dragWidth(640, 1000, 1000 + 5000, 1600), MIN_PREVIEW_WIDTH);
});

test('every preview load asks for a URL the browser has never cached', async () => {
  const { withCacheBust } = await loadComponent('src/components/PreviewPanel.tsx');
  // A bare preview URL: the query goes on the end.
  assert.equal(withCacheBust('http://localhost:3000', '1.2'), 'http://localhost:3000?__danav=1.2');
  // An existing query is kept, and the token is appended, not substituted.
  assert.equal(withCacheBust('http://localhost:3000/?a=1', '3'), 'http://localhost:3000/?a=1&__danav=3');
  // A fragment has to stay last, or the browser would never see the query.
  assert.equal(withCacheBust('http://localhost:3000/#/todo', '9'), 'http://localhost:3000/?__danav=9#/todo');
  assert.equal(withCacheBust('http://localhost:3000/?a=1#x', '9'), 'http://localhost:3000/?a=1&__danav=9#x');
  // Two different loads are two different URLs — that is the whole point.
  const a = withCacheBust('https://x.sandbox.novita.ai', '0.1');
  const b = withCacheBust('https://x.sandbox.novita.ai', '0.2');
  assert.notEqual(a, b);
  // The host is untouched, so the panel still shows the right thing in its bar.
  assert.equal(a.replace(/\?.*$/, ''), 'https://x.sandbox.novita.ai');
});

test('a markdown link to the running app opens the panel instead of a new tab', async () => {
  const ui = await loadComponent('src/components/ChatMessage.tsx');
  const OPEN = { onOpenPreview: () => {} };
  /** A plain chat reply (no agent timeline). */
  const reply = (content, props = OPEN) =>
    renderToStaticMarkup(
      React.createElement(ui.ChatMessage, {
        message: { id: 'm1', role: 'assistant', content, createdAt: 1 },
        ...props,
      })
    );
  /** An agent turn: its prose lives in a text block on the timeline. */
  const agentTurn = (content, props = OPEN) =>
    renderToStaticMarkup(
      React.createElement(ui.ChatMessage, {
        message: {
          id: 'm1', role: 'assistant', content: '', createdAt: 1, agent: true,
          blocks: [{ id: 'b1', type: 'text', content }],
        },
        ...props,
      })
    );

  // The model prints the URL as text far more often than it calls the tool.
  const link = reply('Your app is live at https://3000-abc.us-phx-1.sandbox.novita.ai');
  assert.match(link, /data-testid="open-preview-from-link"/, 'the link grows a panel button');
  assert.match(link, /Open in a new tab/, 'and keeps the new-tab escape hatch');

  const mdLink = reply('See [the demo](https://5174-xyz.sandbox.novita.ai)');
  assert.match(mdLink, /data-testid="open-preview-from-link"/);

  // The agent timeline path renders its own markdown — it must behave the same.
  assert.match(agentTurn('Built it: https://5174-xyz.sandbox.novita.ai'), /data-testid="open-preview-from-link"/);

  // No handler wired through: fall back to a plain link rather than a dead button.
  const noHandler = reply('https://3000-abc.us-phx-1.sandbox.novita.ai', {});
  assert.doesNotMatch(noHandler, /data-testid="open-preview-from-link"/);

  // An ordinary link is left completely alone.
  const normal = reply('Read https://example.com/docs for more');
  assert.doesNotMatch(normal, /data-testid="open-preview-from-link"/);
  assert.match(normal, /example\.com/);

  // A localhost link is a dev server only inside an agent conversation.
  assert.doesNotMatch(reply('running on http://localhost:3000'), /data-testid="open-preview-from-link"/);
  assert.match(agentTurn('running on http://localhost:3000'), /data-testid="open-preview-from-link"/);
});

test('the preview panel renders a divider you can drag', async () => {
  const ui = await loadComponent('src/components/PreviewPanel.tsx');
  // `useIsDesktop` reads window.matchMedia on the first render; there is no DOM
  // in this test, so it is stubbed to say "yes, a laptop".
  const previous = globalThis.window;
  globalThis.window = {
    innerWidth: 1400,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  try {
    const html = renderToStaticMarkup(
      React.createElement(ui.PreviewPanel, {
        url: 'https://3000-abc.sandbox.novita.ai',
        title: 'Todo',
        width: 640,
        onWidthChange: () => {},
        onClose: () => {},
      })
    );
    assert.match(html, /data-testid="preview-resize-handle"/, 'the divider is there');
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-label="Resize the preview"/);
    assert.match(html, /style="width:640px"/, 'the width is applied');
    assert.match(html, /cursor-col-resize/);
    // The divider is absolutely positioned inside the panel, so the panel has to
    // stay its containing block. `lg:static` would silently send it elsewhere.
    assert.match(html, /lg:relative/);
    assert.doesNotMatch(html, /lg:static/);
    assert.match(html, /data-testid="preview-open-tab"/, 'the new-tab escape hatch survives');
    // The bar is a hairline: one 24px row, small text, tight padding. The old
    // two-line header ate a real slice of a 640px-wide preview.
    assert.match(html, /h-6 px-2 border-b/, 'the header is the thin single-row bar');
    assert.doesNotMatch(html, /py-2\.5/, 'no roomy padding left in the header');
    assert.match(html, /text-\[11\.5px\]/, 'the title is small');
    assert.doesNotMatch(html, /text-\[13px\] font-medium text-zinc-900/, 'the old large title is gone');
    // The frame fills the panel, so the embedded page re-flows to whatever
    // width the divider lands on.
    assert.match(html, /<iframe[^>]*class="block w-full h-full/);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('the chat column is a container and the prose is sized from it', () => {
  // Read the stylesheet as text: there is no DOM here, and the contract is
  // simply "these rules exist". The real ramp is measured end-to-end by
  // scripts/preview-harness.js.
  const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

  // The message column has to be a container, or `cqi` below has nothing to
  // resolve against and every message silently falls back to the plain value.
  assert.match(css, /\.chat-column\s*\{[^}]*container-type:\s*inline-size/, 'the column is a query container');

  for (const sel of ['.markdown-body', '.chat-prose']) {
    const rule = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`);
    const m = css.match(rule);
    assert.ok(m, `${sel} has a rule`);
    assert.match(m[1], /font-size:\s*clamp\([^)]*cqi/, `${sel} ramps with the container width`);
    assert.match(m[1], /font-size:\s*[\d.]+px;/, `${sel} keeps a plain fallback first`);
  }

  // The ramp must be a clamp, not a fixed size: a narrow column has to shrink.
  const clamp = css.match(/clamp\(([\d.]+)px,\s*calc\(([\d.]+)cqi \+ ([\d.]+)px\),\s*([\d.]+)px\)/);
  assert.ok(clamp, 'the clamp is well formed');
  const [, min, perCqi, base, max] = clamp.map(Number);
  const at = (px) => Math.min(max, Math.max(min, (perCqi / 100) * px + base));
  // The cqi coefficient is rounded in the stylesheet, so compare with a
  // tolerance rather than to the last decimal.
  const near = (a, b) => Math.abs(a - b) < 0.01;
  assert.ok(near(at(768), 14.4), `a roomy column gets the ceiling (got ${at(768)})`);
  assert.ok(near(at(336), 12.6), `a squeezed column gets the floor (got ${at(336)})`);
  assert.equal(at(2000), max, 'and never grows past the ceiling');
  assert.equal(at(80), min, 'and never collapses below the floor');
  assert.ok(at(768) < 15.2, 'the ceiling is smaller than the old fixed 0.95rem');
  assert.ok(at(336) < at(560) && at(560) < at(768), 'it is a ramp, not a step');

  // Headings in `em`, not `rem`: a heading must shrink with its body text
  // instead of staying huge in a narrow column.
  for (const h of ['h1', 'h2', 'h3', 'h4']) {
    const rule = new RegExp(`\\.markdown-body ${h} \\{ font-size: ([^;]+); \\}`);
    const m = css.match(rule);
    assert.ok(m, `${h} has an explicit size`);
    assert.match(m[1], /em$/, `${h} is sized in em (got ${m[1]})`);
  }
});

test('on a phone the panel covers the screen and there is no divider to drag', async () => {
  const ui = await loadComponent('src/components/PreviewPanel.tsx');
  const previous = globalThis.window;
  globalThis.window = {
    innerWidth: 420,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  try {
    const html = renderToStaticMarkup(
      React.createElement(ui.PreviewPanel, {
        url: 'https://3000-abc.sandbox.novita.ai',
        width: 640,
        onWidthChange: () => {},
        onClose: () => {},
      })
    );
    assert.doesNotMatch(html, /data-testid="preview-resize-handle"/);
    assert.doesNotMatch(html, /style="width:640px"/, 'the fixed full-width class wins instead');
    assert.match(html, /w-\[min\(96vw,720px\)\]/);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

// ---------------------------------------------------------------------------
console.log('\nSandbox management UI');
// ---------------------------------------------------------------------------

const SANDBOX_CONFIG = {
  novita: { configured: true, source: 'env' },
  local: { workspacesDir: '/tmp/ws', allowAnyPath: false, platform: 'linux' },
  limits: { maxSteps: 80, commandTimeoutSeconds: 120 },
  sandbox: { idlePauseSeconds: 180, runGraceSeconds: 90, timeoutMinutes: 15 },
  tools: [],
};

test('the sandbox dialog explains the auto-pause policy instead of hiding it', async () => {
  const ui = await loadComponent('src/components/SandboxManagerDialog.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ui.SandboxManagerDialog, {
      isOpen: true,
      onClose: () => {},
      config: SANDBOX_CONFIG,
      onChanged: () => {},
    })
  );
  // A sandbox that goes to sleep on its own looks like a bug unless it is said out loud.
  assert.match(html, /3 min/, 'the idle window is shown in minutes');
  assert.match(html, /90s/, 'the post-run grace is shown');
  assert.match(html, /15 min/, 'so is the backstop Novita applies itself');
  assert.match(html, /Paused sandboxes keep their files/);
  assert.match(html, /data-testid="sandbox-filter-all"/);
  assert.match(html, /data-testid="sandbox-filter-running"/);
  assert.match(html, /data-testid="sandbox-refresh"/);
});

test('the sandbox dialog is not rendered when it is closed', async () => {
  const ui = await loadComponent('src/components/SandboxManagerDialog.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ui.SandboxManagerDialog, { isOpen: false, onClose: () => {}, config: SANDBOX_CONFIG, onChanged: () => {} })
  );
  assert.equal(html, '');
});

test('the workspace chip shows the sandbox state, and only for cloud workspaces', async () => {
  const ui = await loadComponent('src/components/AgentControls.tsx');
  const base = {
    enabled: true,
    onToggle: () => {},
    activeWorkspaceId: 'ws-1',
    onSelectWorkspace: () => {},
    onCreate: () => {},
    onDelete: () => {},
    onToggleAutoRun: () => {},
    filesOpen: false,
    onToggleFiles: () => {},
    onOpenSandboxes: () => {},
  };
  const sandbox = { id: 'ws-1', name: 'cloudy', kind: 'sandbox', root: '/home/user/cloudy', autoRun: true };

  // "Why is my preview dead?" must be answerable at a glance, not from a dropdown.
  const paused = renderToStaticMarkup(
    React.createElement(ui.AgentControls, { ...base, workspaces: [sandbox], sandboxState: 'paused' })
  );
  assert.match(paused, /data-testid="sandbox-status-pill"/);
  assert.match(paused, />Paused</);
  assert.match(paused, /files kept, nothing billed/, 'the tooltip says what paused means');

  const running = renderToStaticMarkup(
    React.createElement(ui.AgentControls, { ...base, workspaces: [sandbox], sandboxState: 'running' })
  );
  assert.match(running, /data-testid="sandbox-status-pill"/);
  assert.match(running, />Running</);

  // A local workspace has no sandbox, so there is nothing to report.
  const local = renderToStaticMarkup(
    React.createElement(ui.AgentControls, {
      ...base,
      workspaces: [{ ...sandbox, kind: 'local', root: '/tmp/local' }],
      sandboxState: 'paused',
    })
  );
  assert.doesNotMatch(local, /data-testid="sandbox-status-pill"/);

  // No state known yet: the pill would say nothing useful, so it stays away.
  const unknown = renderToStaticMarkup(
    React.createElement(ui.AgentControls, { ...base, workspaces: [sandbox], sandboxState: null })
  );
  assert.doesNotMatch(unknown, /data-testid="sandbox-status-pill"/);
});

test('the sandbox pill is the one-click way into the account-wide manager', async () => {
  const ui = await loadComponent('src/components/AgentControls.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ui.AgentControls, {
      enabled: true,
      onToggle: () => {},
      workspaces: [{ id: 'ws-1', name: 'cloudy', kind: 'sandbox', root: '/home/user/cloudy', autoRun: true }],
      activeWorkspaceId: 'ws-1',
      onSelectWorkspace: () => {},
      onCreate: () => {},
      onDelete: () => {},
      onToggleAutoRun: () => {},
      filesOpen: false,
      onToggleFiles: () => {},
      onOpenSandboxes: () => {},
      sandboxState: 'running',
    })
  );
  // The pill is always on screen for a cloud workspace, so the manager is never
  // more than one click away.
  assert.match(html, /data-testid="sandbox-status-pill"/);
  assert.match(html, /open the sandbox manager/);
});

// ---------------------------------------------------------------------------
console.log('\nThinking accordion');
// ---------------------------------------------------------------------------

test('only one thinking block is open at a time', () => {
  accordion.setOpenThinkingId(null);
  assert.equal(accordion.getOpenThinkingId(), null);
  accordion.setOpenThinkingId('think-1');
  assert.equal(accordion.getOpenThinkingId(), 'think-1');
  // Opening another closes the first: the store ever holds exactly one id.
  accordion.setOpenThinkingId('think-2');
  assert.equal(accordion.getOpenThinkingId(), 'think-2');
  accordion.setOpenThinkingId(null);
  assert.equal(accordion.getOpenThinkingId(), null);
});

test('the accordion notifies subscribers only when the open block really changes', () => {
  let calls = 0;
  accordion.setOpenThinkingId(null);
  const unsubscribe = accordion.subscribeThinkingAccordion(() => {
    calls++;
  });
  accordion.setOpenThinkingId(null); // already closed: no change
  assert.equal(calls, 0);
  accordion.setOpenThinkingId('think-9');
  assert.equal(calls, 1);
  accordion.setOpenThinkingId('think-9'); // same id: no change
  assert.equal(calls, 1);
  accordion.setOpenThinkingId(null);
  assert.equal(calls, 2);
  unsubscribe();
  accordion.setOpenThinkingId('think-10');
  assert.equal(calls, 2, 'an unsubscribed listener must not be called');
  accordion.setOpenThinkingId(null);
});

const act = (over) => ({ id: 'a1', tool: 'write_file', status: 'done', args: {}, ...over });

// ---------------------------------------------------------------------------
test('turn state keeps thinking → text → action → text in the order the model produced them', () => {
  let t = 1000;
  const s = new AgentTurnState(() => t);
  s.appendThinking('Let me think. ');
  s.appendThinking('Plan it.');
  t += 3200;
  s.appendText("I'll build the page.");
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'write_file', args: { path: 'index.html' }, progress: { added: 3 } });
  s.appendText('\n\nNow the styles.'); // leading blank lines of a new paragraph are dropped
  s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'write_file', args: { path: 'style.css' } });
  s.appendText('All done.');
  const snap = s.snapshot();
  assert.deepEqual(snap.blocks.map((b) => b.type), ['thinking', 'text', 'action', 'text', 'action', 'text']);
  assert.equal(snap.blocks[0].isStillThinking, false);
  assert.equal(snap.blocks[0].duration, 3);
  assert.equal(snap.blocks[0].content, 'Let me think. Plan it.');
  assert.equal(snap.blocks[3].content, 'Now the styles.');
  assert.equal(snap.content, "I'll build the page.\n\nNow the styles.\n\nAll done.");
  assert.equal(snap.thinkingContent, 'Let me think. Plan it.');
});

test('turn state: an action row is updated in place — progress, running, streamed output, end', () => {
  const s = new AgentTurnState(() => 5000);
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'write_file', args: {}, progress: { added: 2, tail: ['a'] } });
  const get = () => s.snapshot().blocks[0].action;
  assert.equal(get().status, 'pending');
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { args: { path: 'index.html' }, progress: { added: 40, removed: 7, tail: ['x', 'y'] } } });
  assert.deepEqual([get().args.path, get().progress.added, get().progress.removed, get().progress.tail], ['index.html', 40, 7, ['x', 'y']]);
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { status: 'running' } });
  assert.equal(get().status, 'running');
  assert.equal(get().progress.added, 40, 'the last live numbers stay on screen while the tool runs');
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'line1\n' } });
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'line2\n' } });
  assert.equal(get().output, 'line1\nline2\n');
  s.applyAgentEvent({ type: 'action_end', id: 'a1', status: 'done', ok: true, result: { kind: 'write', added: 77 }, durationMs: 1200 });
  assert.equal(get().status, 'done');
  assert.equal(get().result.added, 77);
  assert.equal(get().approval, null);
  assert.equal(s.snapshot().blocks.length, 1);
});

test('turn state: terminal output is bounded, duplicates and unknown events are ignored, notices stay out of the text', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
  s.applyAgentEvent({ type: 'action_update', id: 'ghost', patch: { status: 'running' } });
  s.applyAgentEvent({ type: 'something_new', x: 1 });
  s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { outputAppend: 'x'.repeat(30_000) + 'END' } });
  s.applyAgentEvent({ type: 'notice', message: 'The sandbox was recreated.' });
  const snap = s.snapshot();
  assert.equal(snap.blocks.filter((b) => b.type === 'action').length, 1);
  const a = snap.blocks[0].action;
  assert.equal(a.output.length, 20_000);
  assert.ok(a.output.endsWith('END'), 'the tail is kept');
  assert.equal(snap.blocks[1].notice, true);
  assert.equal(snap.content, '', 'a notice is not part of the answer text');
});

test('turn state: anything still live when the turn ends is settled (Stopped / Interrupted)', () => {
  const mk = () => {
    const s = new AgentTurnState();
    s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: {} });
    s.applyAgentEvent({ type: 'action_update', id: 'a1', patch: { status: 'awaiting_approval', approval: { key: 'k', command: 'x' } } });
    s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'write_file', args: {}, progress: { added: 9 } });
    s.applyAgentEvent({ type: 'action_start', id: 'a3', tool: 'read_file', args: {} });
    s.applyAgentEvent({ type: 'action_end', id: 'a3', status: 'done', result: { kind: 'read' } });
    s.appendThinking('hmm');
    return s;
  };
  const stopped = mk();
  stopped.finish('aborted');
  const sb = stopped.snapshot().blocks;
  assert.deepEqual(sb.filter((b) => b.type === 'action').map((b) => [b.action.status, b.action.error]), [['error', 'Stopped'], ['error', 'Stopped'], ['done', undefined]]);
  assert.equal(sb.find((b) => b.type === 'action').action.approval, null);
  assert.equal(sb[1].action.progress, undefined, 'live numbers are dropped when the turn is settled');
  assert.equal(sb.find((b) => b.type === 'thinking').isStillThinking, false);
  const lost = mk();
  lost.finish();
  assert.equal(lost.snapshot().blocks.find((b) => b.type === 'action').action.error, 'Interrupted');
});

test('queued: calls waiting for an earlier one are in flight but not "working" (no shimmer); Stop settles them too', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'action_start', id: 'a1', tool: 'run_command', args: { command: 'npm install' } });
  s.applyAgentEvent({ type: 'action_start', id: 'a2', tool: 'grep_search', args: { pattern: 'x' } });
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'queued' } });
  const a2 = () => s.snapshot().blocks[1].action;
  assert.equal(a2().status, 'queued');
  assert.equal(fmt.isLive(a2()), true, 'still in flight, so no "Working…" filler');
  assert.equal(fmt.isWorking(a2()), false, 'but it is not being worked on, so it must not shimmer');
  assert.equal(fmt.isWorking(s.snapshot().blocks[0].action), true);
  assert.equal(fmt.actionLabel(a2()).verb, 'Searching');
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'running' } });
  assert.equal(fmt.isWorking(a2()), true);
  s.applyAgentEvent({ type: 'action_update', id: 'a2', patch: { status: 'queued' } });
  s.finish('aborted');
  assert.deepEqual(s.snapshot().blocks.map((b) => [b.action.status, b.action.error]), [['error', 'Stopped'], ['error', 'Stopped']]);
});

test('turn state: run_end stores the summary', () => {
  const s = new AgentTurnState();
  s.applyAgentEvent({ type: 'run_end', stopReason: 'completed', steps: 4, toolCalls: 9, durationMs: 5000, changed: [{ path: 'a.js', added: 3, removed: 1 }] });
  assert.deepEqual(s.snapshot().agentRun, { stopReason: 'completed', steps: 4, toolCalls: 9, durationMs: 5000, changed: [{ path: 'a.js', added: 3, removed: 1 }] });
});

// ---------------------------------------------------------------------------
test('file icons: exact file name first, then the LONGEST extension, then the generic file', () => {
  const name = (p) => icons.fileIcon(p).name;
  assert.equal(name('index.html'), 'html');
  assert.equal(name('src/style.css'), 'css');
  assert.equal(name('app.js'), 'javascript');
  assert.equal(name('main.ts'), 'typescript');
  assert.equal(name('src/components/App.tsx'), 'react_ts');
  assert.equal(name('script.py'), 'python');
  assert.equal(name('data.json'), 'json');
  assert.equal(name('notes.md'), 'markdown');
  assert.equal(name('logo.png'), 'image');
  assert.equal(name('logo.svg'), 'svg');
  // special names beat the extension (package.json is not just "json")
  assert.equal(name('package.json'), 'nodejs');
  assert.equal(name('tsconfig.json'), 'tsconfig');
  assert.equal(name('vite.config.ts'), 'vite');
  assert.equal(name('Dockerfile'), 'docker');
  assert.equal(name('.gitignore'), 'git');
  assert.equal(name('README.md'), 'readme');
  assert.equal(name('LICENSE'), 'license');
  // the longest extension wins
  assert.equal(name('types.d.ts'), 'typescript-def');
  assert.equal(name('button.test.ts'), 'test-ts');
  // dotenv variants and unknowns
  assert.equal(name('.env'), 'tune');
  assert.equal(name('.env.local'), 'tune');
  assert.equal(name('mystery.zzzz'), 'file');
  assert.equal(name('noextension'), 'file');
  // case does not matter; directories in the path are ignored
  assert.equal(name('SRC/Main.JS'), 'javascript');
  assert.equal(name('C:\\proj\\README.MD'), 'readme');
});

test('folder icons: css / js / src / node_modules look like what they are, with open variants', () => {
  const f = (p, open) => icons.folderIcon(p, open).name;
  assert.equal(f('css'), 'folder-css');
  assert.equal(f('js'), 'folder-javascript');
  assert.equal(f('src'), 'folder-src');
  assert.equal(f('components'), 'folder-components');
  assert.equal(f('images'), 'folder-images');
  assert.equal(f('node_modules'), 'folder-node');
  assert.equal(f('dist'), 'folder-dist');
  assert.equal(f('tests'), 'folder-test');
  assert.equal(f('docs'), 'folder-docs');
  assert.equal(f('.git'), 'folder-git');
  assert.equal(f('src', true), 'folder-src-open');
  assert.equal(f('css', true), 'folder-css-open');
  assert.equal(f('SRC/Utils/CSS'), 'folder-css', 'last segment, any case');
  assert.equal(f('my-random-folder'), 'folder');
  assert.equal(f('my-random-folder', true), 'folder-open');
  assert.equal(f('.'), 'folder');
});

test('file icons: a light-theme variant is offered where the theme has one, and every image exists on disk', () => {
  assert.ok(icons.fileIcon('Cargo.toml').lightSrc || icons.fileIcon('x.toml').lightSrc, 'toml has a light variant');
  assert.equal(icons.fileIcon('app.js').lightSrc, undefined);
  assert.match(icons.fileIcon('app.js').src, /^\/file-icons\/javascript\.svg$/);
  const dir = path.join(root, 'public', 'file-icons');
  const missing = icons.allIconNames().filter((n) => !fs.existsSync(path.join(dir, `${n}.svg`)));
  assert.deepEqual(missing, [], 'every icon the lookup can return must exist as an SVG');
  for (const n of ['javascript', 'css', 'html', 'folder-src', 'folder-css', 'folder-javascript', 'file', 'folder']) {
    const svg = fs.readFileSync(path.join(dir, `${n}.svg`), 'utf8');
    assert.match(svg, /^<svg[^>]*viewBox="0 0 \d+ \d+"/, `${n} is a scalable SVG (has a viewBox)`);
    assert.ok(!/<rect[^>]*(width="16"[^>]*height="16"|height="16"[^>]*width="16")[^>]*fill="#?(fff|ffffff|white)"/i.test(svg), `${n} has no opaque white background`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')), 'the icon theme license ships with the icons');
});

test('wording: "Creating index.html +37" while streaming, "Created … +77" / "Rewrote … +77 −98" after', () => {
  const live = fmt.actionLabel(act({ status: 'pending', args: { path: 'index.html' }, progress: { added: 37, removed: 12 } }));
  assert.deepEqual([live.verb, live.target, live.added, live.removed, live.expandable], ['Creating', 'index.html', 37, 12, false]);
  const created = fmt.actionLabel(act({ result: { kind: 'write', path: 'index.html', created: true, added: 77, removed: 0, hunks: [{ newStart: 1, lines: [] }] } }));
  assert.deepEqual([created.verb, created.added, created.removed, created.expandable], ['Created', 77, undefined, true]);
  const rewrote = fmt.actionLabel(act({ result: { kind: 'write', path: 'index.html', created: false, added: 77, removed: 98 } }));
  assert.deepEqual([rewrote.verb, rewrote.added, rewrote.removed], ['Rewrote', 77, 98]);
});

test('wording: Analyzed with line ranges, Edited with ranges and counts', () => {
  const read = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'src/App.tsx', startLine: 1, endLine: 120, totalLines: 400, truncated: false } }));
  assert.deepEqual([read.verb, read.target, read.lines], ['Analyzed', 'src/App.tsx', 'L1–L120']);
  const reading = fmt.actionLabel(act({ tool: 'read_file', status: 'running', args: { path: 'a.js', startLine: 10, endLine: 20 } }));
  assert.deepEqual([reading.verb, reading.lines], ['Analyzing', 'L10–L20']);
  const one = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'a.js', startLine: 5, endLine: 5, totalLines: 5 } }));
  assert.equal(one.lines, 'L5');
  const edit = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'style.css', ranges: [[12, 18], [40, 44], [80, 80], [90, 91]], added: 9, removed: 4, edits: 4 } }));
  assert.deepEqual([edit.verb, edit.lines, edit.added, edit.removed, edit.meta], ['Edited', 'L12–L18, L40–L44, L80 +1 more', 9, 4, '4 edits']);
  const editing = fmt.actionLabel(act({ tool: 'edit_file', status: 'pending', args: { path: 'a.js' }, progress: { added: 6, removed: 2 } }));
  assert.deepEqual([editing.verb, editing.added, editing.removed], ['Editing', 6, 2]);
});

test('wording: commands — running, success, non-zero exit, timeout, background, approval, denied', () => {
  const running = fmt.actionLabel(act({ tool: 'run_command', status: 'running', args: { command: 'npm install' } }));
  assert.deepEqual([running.verb, running.target, running.targetKind], ['Running', 'npm install', 'command']);
  const ok = fmt.actionLabel(act({ tool: 'run_command', output: 'done', durationMs: 2300, result: { kind: 'command', command: 'npm test', exitCode: 0 } }));
  assert.deepEqual([ok.verb, ok.meta, ok.exitFailed, ok.expandable], ['Ran', '2.3s', false, true]);
  const bad = fmt.actionLabel(act({ tool: 'run_command', status: 'error', error: 'x', output: 'boom', durationMs: 1000, result: { kind: 'command', command: 'npm test', exitCode: 1 } }));
  assert.deepEqual([bad.verb, bad.meta, bad.exitFailed], ['Ran', 'exit 1 · 1.0s', true], 'a failing command ran; the exit code is the news');
  const timeout = fmt.actionLabel(act({ tool: 'run_command', status: 'error', result: { kind: 'command', command: 'sleep 9', exitCode: 124, timedOut: true } }));
  assert.match(timeout.meta, /timed out/);
  const bg = fmt.actionLabel(act({ tool: 'run_command', args: { background: true }, result: { kind: 'background', command: 'vite --host', id: 'bg-1', ports: [5173] } }));
  assert.deepEqual([bg.verb, bg.chips], ['Started', ['bg-1', ':5173']]);
  const reused = fmt.actionLabel(act({ tool: 'run_command', args: { background: true }, result: { kind: 'background', command: 'vite', id: 'bg-1', ports: [5173], reused: true } }));
  assert.deepEqual([reused.verb, reused.chips], ['Already running', ['bg-1', ':5173']]);
  const wait = fmt.actionLabel(act({ tool: 'run_command', status: 'awaiting_approval', approval: { key: 'k', command: 'rm -r build' }, args: { command: 'rm -r build' } }));
  assert.deepEqual([wait.verb, wait.target], ['Waiting for approval to run', 'rm -r build']);
  const denied = fmt.actionLabel(act({ tool: 'run_command', status: 'denied', args: { command: 'rm x' } }));
  assert.deepEqual([denied.verb, denied.meta], ['Skipped', 'not allowed']);
});

test('wording: a tool that FAILED says so, with the first line of the reason', () => {
  const e = fmt.actionLabel(act({ tool: 'edit_file', status: 'error', args: { path: 'a.js' }, error: 'old_string was not found in the file.\n\nClosest match…' }));
  assert.deepEqual([e.verb, e.target, e.meta, e.expandable], ["Couldn't edit", 'a.js', 'old_string was not found in the file.', true]);
  const r = fmt.actionLabel(act({ tool: 'read_file', status: 'error', args: { path: 'nope.txt' }, error: 'File not found: nope.txt' }));
  assert.equal(r.verb, "Couldn't read");
  const s = fmt.actionLabel(act({ tool: 'grep_search', status: 'error', args: { pattern: '(' }, error: 'grep failed' }));
  assert.equal(s.verb, 'Search failed:');
});

test('wording: a write whose body was saved without a path reads "Saved", not "Couldn\'t"', () => {
  // The tool-call JSON arrived with no usable path. The body was parked, so the
  // row must not claim the file failed to be written — it waits for a move.
  const a = fmt.actionLabel(act({
    tool: 'write_file',
    status: 'error',
    args: {},
    result: { kind: 'write', ok: false, path: '.danav-recovered/write_file-1.txt', recovered: true },
    error: 'This write_file call arrived without a usable "path", so nothing was written where you meant.\nThe body is NOT lost: 16 complete lines are saved at .danav-recovered/write_file-1.txt.',
  }));
  assert.deepEqual([a.verb, a.target, a.meta, a.expandable], ['Saved', '.danav-recovered/write_file-1.txt', 'waiting for a path', false]);
});

test('wording: an action the run REFUSED reads "Refused", not "Couldn\'t"', () => {
  // The gate stops a delete the agent never inspected. That is a redirection,
  // not a crash, and it must not be dressed up as one.
  const b = fmt.actionLabel(act({
    tool: 'delete_file',
    status: 'blocked',
    args: { path: 'legacy' },
    result: { kind: 'delete', path: 'legacy', isDir: true, blocked: true },
    error: 'Refused: nothing was deleted. `legacy/` is a folder and you have not looked inside it in this run.',
  }));
  assert.equal(b.verb, 'Refused');
  assert.equal(b.target, 'legacy');
  assert.equal(b.meta, 'Refused: nothing was deleted. `legacy/` is a folder and you have not looked inside it in this run.');
  assert.equal(b.added, undefined, 'and it never claims to have changed anything');
  assert.equal(b.expandable, true, 'the full reason is one click away');
});

test('wording: an action cut off by Stop / a lost connection reads "Stopped" / "Interrupted"', () => {
  const stopped = fmt.actionLabel(act({ tool: 'run_command', status: 'error', error: 'Stopped', args: { command: 'npm install' }, output: 'added 3 packages' }));
  assert.deepEqual([stopped.verb, stopped.target, stopped.meta, stopped.expandable], ['Stopped', 'npm install', undefined, true]);
  const lost = fmt.actionLabel(act({ tool: 'write_file', status: 'error', error: 'Interrupted', args: { path: 'index.html' } }));
  assert.deepEqual([lost.verb, lost.target, lost.added], ['Interrupted', 'index.html', undefined]);
});

test('wording: several chunks, a multi-file edit, an outline', () => {
  const chunks = fmt.actionLabel(act({ tool: 'read_file', result: { kind: 'read', path: 'big.js', startLine: 1, endLine: 300, totalLines: 300, ranges: [[1, 50], [200, 260]] } }));
  assert.deepEqual([chunks.verb, chunks.lines], ['Analyzed', 'L1–L50, L200–L260']);
  const many = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'a.js', added: 5, removed: 2, edits: 4, ranges: [[1, 1]], changes: [{ path: 'a.js', added: 3, removed: 1, edits: 2 }, { path: 'b.css', added: 2, removed: 1, edits: 2 }] } }));
  assert.deepEqual([many.verb, many.target, many.lines, many.added, many.removed, many.meta], ['Edited', 'a.js', undefined, 5, 2, '2 files · 4 edits']);
  const live = fmt.actionLabel(act({ tool: 'multi_edit', status: 'running', args: { edits: 6 }, progress: { added: 3, removed: 2 } }));
  assert.deepEqual([live.verb, live.meta, live.added, live.removed], ['Editing', '6 edits', 3, 2]);
  const one = fmt.actionLabel(act({ tool: 'multi_edit', result: { kind: 'edit', path: 'a.js', added: 1, removed: 1, edits: 3, ranges: [[4, 4], [9, 9], [20, 22]], hunks: [{ newStart: 4, lines: [] }] } }));
  assert.deepEqual([one.lines, one.meta, one.expandable], ['L4, L9, L20–L22', '3 edits', true]);
  const outline = fmt.actionLabel(act({ tool: 'file_outline', result: { kind: 'outline', path: 'src/App.tsx', count: 18 } }));
  assert.deepEqual([outline.verb, outline.target, outline.meta], ['Outlined', 'src/App.tsx', '18 symbols']);
  assert.equal(fmt.actionLabel(act({ tool: 'file_outline', status: 'running', args: { path: 'x.js' } })).verb, 'Outlining');
  // the next turn remembers every file a batch touched
  const lines = fmt.collectActivity([{ role: 'assistant', content: 'x', blocks: [{ type: 'action', id: 'b', action: act({ tool: 'multi_edit', result: { kind: 'edit', changes: [{ path: 'a.js', added: 3, removed: 1 }, { path: 'b.css', added: 2, removed: 1 }] } }) }] }]);
  assert.deepEqual(lines, ['edited a.js (+3 −1)', 'edited b.css (+2 −1)']);
});

test('wording: search, list, web, plan and the rest', () => {
  assert.equal(fmt.actionLabel(act({ tool: 'grep_search', result: { kind: 'grep', pattern: 'useState', count: 8, files: 3 } })).meta, '8 matches in 3 files');
  assert.equal(fmt.actionLabel(act({ tool: 'grep_search', result: { kind: 'grep', pattern: 'zzz', count: 0, files: 0 } })).meta, 'no matches');
  assert.equal(fmt.actionLabel(act({ tool: 'list_dir', result: { kind: 'list', path: 'src', count: 1 } })).meta, '1 item');
  assert.deepEqual(fmt.actionLabel(act({ tool: 'file_search', result: { kind: 'find', pattern: '*.tsx', count: 5 } })).meta, '5 files');
  const web = fmt.actionLabel(act({ tool: 'web_search', result: { kind: 'web_search', query: 'vite proxy', count: 8 } }));
  assert.deepEqual([web.verb, web.meta], ['Searched the web for', '8 results']);
  assert.equal(fmt.actionLabel(act({ tool: 'fetch_url', result: { kind: 'fetch', url: 'https://www.example.com/docs/a', title: 'Docs' } })).target, 'example.com');
  const plan = fmt.actionLabel(act({ tool: 'update_plan', result: { kind: 'plan', done: 2, total: 5, todos: [{ content: 'x', status: 'completed' }] } }));
  assert.deepEqual([plan.verb, plan.meta, plan.expandable], ['Updated plan', '2/5 done', true]);
  const preview = fmt.actionLabel(act({ tool: 'get_preview_url', result: { kind: 'preview', port: 3000, url: 'https://x' } }));
  assert.deepEqual([preview.verb, preview.target], ['Preview ready on port', '3000']);
  assert.equal(fmt.actionLabel(act({ tool: 'mystery_tool' })).verb, 'Ran');
});

test('formatRanges / formatDuration / changedSummary / stopNotice', () => {
  assert.equal(fmt.formatRanges([[3, 3]]), 'L3');
  assert.equal(fmt.formatRanges([[3, 9]]), 'L3–L9');
  assert.equal(fmt.formatRanges([]), undefined);
  assert.equal(fmt.formatDuration(100), undefined);
  assert.equal(fmt.formatDuration(2345), '2.3s');
  assert.equal(fmt.formatDuration(42_000), '42s');
  assert.equal(fmt.formatDuration(125_000), '2m 5s');
  assert.deepEqual(fmt.changedSummary([{ path: 'a', added: 5, removed: 1 }, { path: 'b', added: 2, removed: 0 }]), { files: 2, added: 7, removed: 1 });
  assert.equal(fmt.changedSummary([]), undefined);
  assert.match(fmt.stopNotice('step_limit'), /continue/);
  assert.match(fmt.stopNotice('no_progress'), /same call|same answer/i);
  assert.equal(fmt.stopNotice('completed'), undefined);
});

test('collectActivity: one line per meaningful action, newest last, reads and searches skipped', () => {
  const blocks = [
    { type: 'text', id: 't', content: 'x' },
    { type: 'action', id: 'b1', action: act({ id: '1', tool: 'write_file', result: { kind: 'write', path: 'a.js', created: true, added: 10, removed: 0 } }) },
    { type: 'action', id: 'b2', action: act({ id: '2', tool: 'read_file', result: { kind: 'read', path: 'a.js' } }) },
    { type: 'action', id: 'b3', action: act({ id: '3', tool: 'edit_file', result: { kind: 'edit', path: 'a.js', added: 2, removed: 1 } }) },
    { type: 'action', id: 'b4', action: act({ id: '4', tool: 'run_command', result: { kind: 'command', command: 'node a.js', exitCode: 0 } }) },
    { type: 'action', id: 'b5', action: act({ id: '5', tool: 'edit_file', status: 'error', error: 'x' }) },
    { type: 'action', id: 'b6', action: act({ id: '6', tool: 'run_command', status: 'denied', args: { command: 'rm x' } }) },
    { type: 'action', id: 'b7', action: act({ id: '7', tool: 'get_preview_url', result: { kind: 'preview', url: 'https://p' } }) },
  ];
  const lines = fmt.collectActivity([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok', blocks }]);
  assert.deepEqual(lines, [
    'created a.js (+10 −0)',
    'edited a.js (+2 −1)',
    'ran `node a.js` → exit 0',
    'run_command (denied by user): rm x',
    'preview: https://p',
  ]);
  assert.equal(fmt.collectActivity([{ role: 'assistant', content: 'x', blocks }], 2).length, 2);
});

// ---------------------------------------------------------------------------
// The real data path: Express route + fake LLM  →  SSE client  →  blocks
// ---------------------------------------------------------------------------

test('data path: runAgentTurn turns a real SSE run into ordered blocks (and Stop settles them)', async () => {
  const saved = {
    DANAV_DATA_DIR: process.env.DANAV_DATA_DIR,
    DANAV_WORKSPACES_DIR: process.env.DANAV_WORKSPACES_DIR,
  };
  process.env.DANAV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-fe-data-'));
  process.env.DANAV_WORKSPACES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-fe-ws-'));
  _resetStoreCache();
  const llm = await startFakeLlm();
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, init);

  try {
    const { runAgentTurn } = await load('src/agent/runAgentTurn.ts');
    const { createWorkspace } = await load('src/services/agentApi.ts');
    const ws = await createWorkspace({ name: 'fe', kind: 'local', autoRun: true });
    const provider = { id: 'p', name: 'fake', baseUrl: llm.baseUrl, apiType: 'openai', models: [] };

    // 1) a complete run
    const updates = [];
    let finished;
    await runAgentTurn({
      provider, model: 'fake-build', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'build a page' }],
      signal: new AbortController().signal,
      onUpdate: (snap) => updates.push(snap.blocks.map((b) => b.type + (b.type === 'action' ? `:${b.action.tool}:${b.action.status}` : ''))),
      onFinish: (snap, error, stopReason) => { finished = { snap, error, stopReason }; },
    });
    assert.equal(finished.error, undefined);
    assert.equal(finished.stopReason, 'completed');
    const types = finished.snap.blocks.map((b) => (b.type === 'action' ? `action:${b.action.tool}` : b.type));
    assert.deepEqual(types, [
      'thinking', 'text', 'action:update_plan', 'action:write_file', 'action:write_file',
      'text', 'action:read_file', 'action:multi_edit', 'action:edit_file',
      'action:run_command', 'action:grep_search', 'action:list_dir',
      // the model's closing answer
      'text',
    ]);
    assert.ok(finished.snap.blocks.filter((b) => b.type === 'action').every((b) => b.action.status === 'done'));
    assert.equal(finished.snap.blocks[0].isStillThinking, false);
    assert.match(finished.snap.content, /^I'll set up a small landing page\.\n\nNow a couple of refinements\.\n\nDone! I created index\.html/);
    assert.equal(finished.snap.agentRun.changed.length, 2);
    // while it ran, an action was seen in the pending state and later as done (live UI)
    assert.ok(updates.some((u) => u.includes('action:write_file:pending')));
    assert.ok(updates.at(-1).every((t) => !t.endsWith(':running') && !t.endsWith(':pending')));

    // 2) press Stop in the middle of a command
    const ac = new AbortController();
    let stopped;
    await runAgentTurn({
      provider, model: 'fake-slow', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'go' }],
      signal: ac.signal,
      onUpdate: (snap) => {
        const cmd = snap.blocks.find((b) => b.type === 'action' && b.action.tool === 'run_command' && b.action.status === 'running');
        if (cmd && !ac.signal.aborted) setTimeout(() => ac.abort(), 300);
      },
      onFinish: (snap, error) => { stopped = { snap, error }; },
    });
    const cmd = stopped.snap.blocks.find((b) => b.type === 'action' && b.action.tool === 'run_command').action;
    assert.equal(cmd.status, 'error');
    assert.equal(cmd.error, 'Stopped');
    assert.equal(stopped.error, undefined, 'a user stop is not an error');

    // 3) a server-side failure is surfaced, not swallowed
    let failed;
    await runAgentTurn({
      provider: { ...provider, apiType: 'mock' }, model: 'x', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{ role: 'user', content: 'go' }],
      signal: new AbortController().signal,
      onUpdate: () => {},
      onFinish: (snap, error) => { failed = error; },
    });
    assert.match(failed, /Demo provider cannot run the agent/);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await llm.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetStoreCache();
  }
});

test('data path: an attached image reaches the provider as an image part', async () => {
  const saved = {
    DANAV_DATA_DIR: process.env.DANAV_DATA_DIR,
    DANAV_WORKSPACES_DIR: process.env.DANAV_WORKSPACES_DIR,
  };
  process.env.DANAV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-img-data-'));
  process.env.DANAV_WORKSPACES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-img-ws-'));
  _resetStoreCache();
  const llm = await startFakeLlm();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, init);

  try {
    const { runAgentTurn } = await load('src/agent/runAgentTurn.ts');
    const { createWorkspace } = await load('src/services/agentApi.ts');
    const ws = await createWorkspace({ name: 'img', kind: 'local', autoRun: true });
    const provider = { id: 'p', name: 'fake', baseUrl: llm.baseUrl, apiType: 'openai', models: [] };
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    await runAgentTurn({
      provider, model: 'fake-silent', thinkingLevel: 'Auto', workspaceId: ws.id, activity: [],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this screenshot?' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      signal: new AbortController().signal,
      onUpdate: () => {},
      onFinish: () => {},
    });

    // The whole point: the image is still there when the request goes out.
    // (cleanHistory used to drop every non-string message, so the model never saw it.)
    const sent = llm.requests[0]?.messages || [];
    const user = sent.find((m) => m.role === 'user');
    assert.ok(user, 'the user message survived into the request');
    assert.ok(Array.isArray(user.content), 'it kept its multimodal shape');
    assert.deepEqual(user.content[0], { type: 'text', text: 'what is in this screenshot?' });
    const image = user.content.find((p) => p.type === 'image_url');
    assert.ok(image, 'an image part was sent');
    assert.equal(image.image_url.url, imageUrl, 'the image bytes reached the provider');
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await llm.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetStoreCache();
  }
});

// ---------------------------------------------------------------------------
console.log('\nChat data: the backup path and the settings tab');
// ---------------------------------------------------------------------------

test('Settings offers a Chat Data tab (the backup it explains is only reachable from there)', async () => {
  const ui = await loadComponent('src/components/SettingsModal.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ui.SettingsModal, {
      isOpen: true,
      onClose: () => {},
      theme: 'light',
      onThemeChange: () => {},
      providers: [],
      onSaveProviders: () => true,
      conversations: [],
      onConversationsRestored: () => {},
    })
  );
  assert.match(html, /Chat Data/, 'the tab is reachable');
  assert.match(html, /Appearance/, 'and the other tabs are still there');
});

test('the composer owns the draft, keeps the caret, and the chat is memoised', async () => {
  const ui = await loadComponent('src/components/ChatInput.tsx');
  const area = await loadComponent('src/components/ChatArea.tsx');
  const message = await loadComponent('src/components/ChatMessage.tsx');

  // Memo, not just a plain function component: a streaming answer re-renders the
  // app on every token, and without this every message (markdown included) and the
  // whole composer were rebuilt for each one.
  const memoType = Symbol.for('react.memo');
  for (const [name, component] of [
    ['ChatInput', ui.ChatInput],
    ['ChatArea', area.ChatArea],
    ['ChatMessage', message.ChatMessage],
  ]) {
    assert.equal(component.$$typeof, memoType, `${name} must be memoised`);
  }

  // An empty composer renders a disabled send button — the draft it sends lives
  // inside the component now (the app re-rendering per keystroke was the lag).
  const html = renderToStaticMarkup(
    React.createElement(ui.ChatInput, {
      draftResetKey: 0,
      onSend: () => {},
      isLoading: false,
      onStop: () => {},
      providers: [],
      selectedProviderId: '',
      selectedModelId: '',
      thinkingLevel: 'Auto',
      onSelectModel: () => {},
      onSelectThinkingLevel: () => {},
    })
  );
  assert.match(html, /<textarea/, 'the box is a textarea');
  assert.match(html, /disabled/, 'nothing typed yet: send starts disabled');

  const input = fs.readFileSync(path.join(root, 'src/components/ChatInput.tsx'), 'utf8');
  // Collapsing the box to measure on every keystroke is what made a long prompt
  // scroll back to the top while typing (and forced a reflow per key).
  const collapses = input.match(/el\.style\.height = 'auto';/g) || [];
  assert.equal(collapses.length, 1, 'the box is collapsed exactly once, and only to measure');
  assert.match(input, /if \(shrunk\) el\.style\.height = 'auto';/, 'that collapse is guarded by "the text got shorter"');
  // Sending must not cost the user the focus: the box is cleared from the app's
  // reset token and the caret is put back by hand.
  assert.match(input, /el\.focus\(\{ preventScroll: true \}\)/, 'the caret comes back on its own');

  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  assert.ok(!/setInput\b/.test(app), 'the app no longer holds the draft');
  assert.match(app, /useStable\(/, 'callbacks handed to the memoised children never change identity');
  // localStorage was written synchronously on every token of a stream.
  assert.match(app, /scheduleStoredConversations\(conversations\)/, 'storage writes are coalesced');
  assert.ok(!/saveStoredConversations\(conversations\)/.test(app), 'and no longer per token');
});

test('a missing backup reads as "nothing to restore yet", not as an error', async () => {
  const api = await load('src/services/api.ts');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: 'No backup available' }),
    });
    const missing = await api.fetchConversationsBackup();
    assert.equal(missing.success, false);
    assert.match(missing.error, /No backup yet/);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, conversations: [{ id: 'c1', messages: [] }], activeChatId: 'c1' }),
    });
    const found = await api.fetchConversationsBackup();
    assert.equal(found.success, true);
    assert.equal(found.conversations.length, 1);
    assert.equal(found.activeChatId, 'c1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('copying falls back when the Clipboard API is refused (sandboxed preview)', async () => {
  const { copyText } = await load('src/utils/clipboard.ts');
  const realNavigator = globalThis.navigator;
  const realDocument = globalThis.document;
  try {
    // A sandboxed iframe: `navigator.clipboard` rejects, and the legacy path is
    // the only one left. Before this fallback the Copy button silently did nothing.
    globalThis.navigator = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
    let copiedValue = '';
    let appended = null;
    globalThis.document = {
      createElement: () => ({ style: {}, setAttribute() {}, select() { copiedValue = this.value; }, remove() {} }),
      body: { appendChild: (el) => { appended = el; } },
      getSelection: () => null,
      execCommand: (command) => command === 'copy',
    };

    const ok = await copyText('hello');
    assert.equal(ok, true, 'the fallback reports success');
    assert.equal(copiedValue, 'hello', 'the text was actually in the selected element');
    assert.ok(appended, 'it was attached to the document to be selectable');
  } finally {
    if (realNavigator === undefined) delete globalThis.navigator; else globalThis.navigator = realNavigator;
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});
