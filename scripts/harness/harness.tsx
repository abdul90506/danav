/*
 * Throwaway harness: mounts the real PreviewPanel next to the real ChatArea and
 * drives a synthetic drag, so the things that are impossible to assert from a
 * static render can be measured for real.
 *
 *   node scripts/preview-harness.js
 *
 * It writes its findings into `window.__harness` and into <pre id="results">,
 * which is what the headless run reads back.
 */
import '../../src/index.css';
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewPanel } from '../../src/components/PreviewPanel';
import { ChatArea } from '../../src/components/ChatArea';

const results: string[] = [];
let out = document.createElement('pre');
out.id = 'results';
document.body.appendChild(out);

const say = (key: string, value: unknown) => {
  results.push(`${key}=${JSON.stringify(value)}`);
  out.textContent = results.join('\n');
  (window as never as Record<string, unknown>).__harness = results;
};

addEventListener('error', (e) => say('UNCAUGHT', String((e as ErrorEvent).message)));
addEventListener('unhandledrejection', (e) => say('REJECTED', String((e as PromiseRejectionEvent).reason)));

let renders = 0;

const Harness: React.FC = () => {
  renders++;
  const [width, setWidth] = useState(640);
  return (
    <div className="app-viewport flex w-screen overflow-hidden bg-white">
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <ChatArea
          isLoading={false}
          messages={[
            { id: 'm1', role: 'assistant', content: 'Short answer with **bold** text.' },
            { id: 'm2', role: 'user', content: 'A user bubble that should shrink too.' },
            {
              id: 'm3',
              role: 'assistant',
              content: '# Heading\n\nBody copy that needs to read well in a narrow column. '.repeat(6),
            },
          ] as never}
        />
      </div>
      <PreviewPanel
        url="/scripts/harness/responsive.html"
        title="Todo app"
        width={width}
        onWidthChange={setWidth}
        onClose={() => {}}
      />
    </div>
  );
};

const waitFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function pointer(type: string, x: number, target: Element) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: 400,
    })
  );
}

async function main() {
  say('step', 'boot');
  const root = createRoot(document.getElementById('root')!);
  root.render(<Harness />);
  await waitFrame();
  await waitFrame();
  say('step', 'mounted');

  const panel = document.querySelector('[data-testid="preview-panel"]') as HTMLElement;
  const handle = document.querySelector('[data-testid="preview-resize-handle"]') as HTMLElement;
  const frame = panel.querySelector('iframe') as HTMLIFrameElement;
  const header = panel.firstElementChild!.nextElementSibling as HTMLElement;
  const prose = document.querySelector('.markdown-body') as HTMLElement;
  const bubble = document.querySelector('.chat-prose') as HTMLElement;

  say('panel_width_at_rest', Math.round(panel.getBoundingClientRect().width));
  say('header_height', Math.round(header.getBoundingClientRect().height));
  say('prose_font', getComputedStyle(prose).fontSize);
  say('bubble_font', getComputedStyle(bubble).fontSize);

  // ---- the drag ----------------------------------------------------------
  const rendersBefore = renders;
  pointer('pointerdown', 1000, handle);
  await waitFrame();
  const rendersAfterDown = renders;
  say('step', 'pointerdown');

  // Three moves inside ONE frame: only the last one may cost anything.
  pointer('pointermove', 950, handle);
  pointer('pointermove', 900, handle);
  pointer('pointermove', 800, handle);
  await waitFrame();

  const liveWidth = panel.style.width;
  const rendersAfterMove = renders;
  say('live_width_mid_drag', liveWidth);
  say('renders_pointerdown', rendersAfterDown - rendersBefore);
  say('renders_pointermove', rendersAfterMove - rendersAfterDown);
  say('step', 'first-frame-moves');

  // A few more frames of dragging, to see whether the panel keeps up.
  const seen: string[] = [];
  for (const x of [700, 620, 560]) {
    pointer('pointermove', x, handle);
    await waitFrame();
    seen.push(panel.style.width);
  }
  say('tracked_widths', seen);
  say('renders_after_more_moves', renders - rendersAfterMove);
  say('step', 'tracked');

  pointer('pointerup', 560, handle);
  await waitFrame();
  await waitFrame();
  say('committed_width', Math.round(panel.getBoundingClientRect().width));
  say('renders_on_release', renders - rendersAfterMove);
  say('body_user_select_restored', document.body.style.userSelect === '');
  say('step', 'released');

  await new Promise((r) => setTimeout(r, 300));
  say('iframe_viewport', frame.contentWindow?.innerWidth);
  say('iframe_band', (frame.contentWindow?.document.getElementById('band') as HTMLElement)?.textContent);
  say('prose_font_after_drag', getComputedStyle(prose).fontSize);
  say('bubble_font_after_drag', getComputedStyle(bubble).fontSize);
  say('chat_column_width_after_drag', Math.round(document.querySelector('.chat-column')!.getBoundingClientRect().width));
  say('header_height_after_drag', Math.round(header.getBoundingClientRect().height));
  say('step', 'done');
}

main().catch((err) => say('THREW', String(err && err.stack ? err.stack.split('\n')[0] : err)));
