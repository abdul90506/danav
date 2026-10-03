/*
 * Harness: does the docked preview actually show the NEW build?
 *
 *   node scripts/preview-reload-harness.js
 *
 * The bug this exists for cannot be caught by a static render: the panel looked
 * fine, but when the app behind a stable preview URL was rebuilt, the frame had
 * nothing to react to and kept showing the previous page — while a new tab
 * showed the new one. So this mounts the real PreviewPanel in a real browser,
 * points it at a real HTTP server that serves a *cached* mutable page, and asks
 * the page itself (over postMessage) which build it is.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewPanel } from '../../src/components/PreviewPanel';

const results: string[] = [];
const out = document.createElement('pre');
out.id = 'results';
document.body.appendChild(out);

const say = (key: string, value: unknown) => {
  results.push(`${key}=${JSON.stringify(value)}`);
  out.textContent = results.join('\n');
  (window as never as Record<string, unknown>).__harness = results;
};

addEventListener('error', (e) => say('UNCAUGHT', String((e as ErrorEvent).message)));
addEventListener('unhandledrejection', (e) => say('REJECTED', String((e as PromiseRejectionEvent).reason)));

/** Every build the frame has announced, in order. */
const builds: string[] = [];
addEventListener('message', (e) => {
  const data = e.data as { danavBuild?: string } | null;
  if (data?.danavBuild) builds.push(data.danavBuild);
});

const params = new URLSearchParams(location.search);
const url = params.get('preview') || 'about:blank';

const Harness: React.FC = () => {
  const [token, setToken] = useState(1);
  // What the host does on every open / refresh — the only knob the panel has.
  (window as never as Record<string, unknown>).__bump = () => setToken((n) => n + 1);
  (window as never as Record<string, unknown>).__token = token;
  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      <PreviewPanel url={url} title="Build" width={560} onWidthChange={() => {}} onClose={() => {}} reloadKey={token} />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<Harness />);
(window as never as Record<string, unknown>).__builds = builds;
say('step', 'mounted');
