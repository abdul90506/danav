/*
 * Replays a REAL captured agent stream (scripts/harness/live-events.json, written
 * by `node scripts/probe-live.js <model> --dump ...`) through the REAL turn state
 * and the REAL ChatMessage, and prints the row as it looked at several moments
 * during the write.
 *
 *   node scripts/probe-live.js models/gemini-3.5-flash-lite --dump scripts/harness/live-events.json
 *   # then open /scripts/harness/row.html on the dev server
 *
 * Nothing here is mocked: the numbers on screen came off a live provider.
 */
import '../../src/index.css';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessage } from '../../src/components/ChatMessage';
import { AgentTurnState } from '../../src/agent/turnState';
import type { Message } from '../../src/types';

interface Captured {
  t: number;
  content?: string;
  thinking?: string;
  status?: string;
  agent?: { type: string } & Record<string, unknown>;
}

/** Rebuild the turn from every event up to `untilMs`, using the app's own state machine. */
function replayAt(events: Captured[], untilMs: number): Message {
  const state = new AgentTurnState();
  for (const ev of events) {
    if (ev.t > untilMs) break;
    if (ev.content) state.appendText(ev.content);
    else if (ev.thinking) state.appendThinking(ev.thinking);
    else if (ev.agent) state.applyAgentEvent(ev.agent);
  }
  const snap = state.snapshot();
  return {
    id: 'm1',
    role: 'assistant',
    content: snap.content,
    blocks: snap.blocks,
    agent: true,
    isGenerating: true,
    createdAt: 0,
  };
}

const STEPS = [0, 350, 800, 1600, 2600, 4000];

const Row: React.FC = () => {
  const [events, setEvents] = useState<Captured[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch('/scripts/harness/live-events.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setEvents)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <pre style={{ padding: 16 }}>{err}</pre>;
  if (!events) return <pre style={{ padding: 16 }}>loading…</pre>;

  // The first write_file: everything from the moment its row opens.
  const startIdx = events.findIndex((e) => e.agent?.type === 'action_start' && (e.agent as { tool?: string }).tool === 'write_file');
  if (startIdx < 0) return <pre style={{ padding: 16 }}>no write_file in the capture</pre>;
  const t0 = events[startIdx].t;
  const endIdx = events.findIndex((e, i) => i > startIdx && e.agent?.type === 'action_end');

  return (
    <div className="bg-white p-5 font-sans text-zinc-900">
      <div className="mb-4 text-[13px] text-zinc-500">
        Replaying a real capture: <b>{events.length}</b> events, write_file opens at {t0}ms, ends at{' '}
        {endIdx > -1 ? `${events[endIdx].t}ms (${events[endIdx].t - t0}ms later)` : '—'}
      </div>
      {STEPS.map((step) => {
        const msg = replayAt(events, t0 + step);
        const action = msg.blocks?.find((b) => b.type === 'action');
        const p = action && action.type === 'action' ? action.action.progress : undefined;
        return (
          <div key={step} className="mb-5 pb-4 border-b border-dashed border-zinc-200">
            <div className="mb-1 font-mono text-[11px] text-zinc-400">
              t+{String(step).padStart(4)}ms&nbsp;&nbsp;{p ? `progress +${p.added} −${p.removed} · ${p.tail?.length ?? 0} tail lines` : 'no progress yet'}
            </div>
            <ChatMessage message={msg} />
          </div>
        );
      })}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<Row />);
