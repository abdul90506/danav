import type { ChatMessageContent, Provider, ThinkingLevel } from '../types';
import { streamAgentRun } from '../services/agentApi';
import { SmoothStreamer } from '../utils/smoothStream';
import { AgentTurnState, type TurnSnapshot } from './turnState';

export interface RunAgentTurnOptions {
  provider: Provider;
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ChatMessageContent }>;
  workspaceId: string;
  /** Stable id of this assistant task; Continue reuses it to restore only its own checkpoint. */
  taskId?: string;
  /** What the agent did earlier in this conversation, one line each. */
  activity: string[];
  /** This turn continues a run that stopped early (see App.tsx RESUME_NOTE). */
  resume?: boolean;
  signal: AbortSignal;
  /** Fired on every change while the turn runs. `status` is a transient note ("Provider busy — retrying…"). */
  onUpdate: (snapshot: TurnSnapshot, status: string) => void;
  /** Fired once, when the turn is over (finished, stopped or failed). */
  onFinish: (snapshot: TurnSnapshot, error?: string, stopReason?: string) => void;
  /** Lets the host flush the streamers when the user presses Stop. */
  onStreamers?: (text: SmoothStreamer, thinking: SmoothStreamer) => void;
}

/**
 * Run one agent turn: stream it from the server and keep the chronological
 * transcript (see AgentTurnState) up to date for the UI.
 *
 * Text and reasoning go through SmoothStreamer for the same fluid typing as the
 * normal chat; before any action event is applied both streamers are flushed,
 * so a sentence never lands after the action that followed it. The accepted final
 * answer is the exception: it stays live below the work row until its stream drains.
 */
export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<void> {
  const state = new AgentTurnState();
  let status = '';
  let errorMessage: string | undefined;
  let finalAnswerStarted = false;

  const sync = () => opts.onUpdate(state.snapshot(), status);

  const textStreamer = new SmoothStreamer((t) => {
    state.appendText(t);
    sync();
  });
  const thinkingStreamer = new SmoothStreamer((t) => {
    state.appendThinking(t);
    sync();
  });
  opts.onStreamers?.(textStreamer, thinkingStreamer);

  await streamAgentRun({
    provider: opts.provider,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    messages: opts.messages,
    workspaceId: opts.workspaceId,
    taskId: opts.taskId,
    activity: opts.activity,
    resume: opts.resume,
    signal: opts.signal,
    onStatus: (s) => {
      if (!finalAnswerStarted) status = s;
      sync();
    },
    onContent: (c) => {
      thinkingStreamer.flushImmediate(); // reasoning that came first must land first
      textStreamer.push(c);
    },
    onThinking: (t) => thinkingStreamer.push(t),
    onAgent: (ev) => {
      if (ev?.type === 'final_answer_start') {
        textStreamer.flushImmediate();
        thinkingStreamer.flushImmediate();
        finalAnswerStarted = true;
        status = 'Writing final answer…';
      } else {
        // run_end follows the final content event. Let its paced text finish
        // below the work row instead of dumping the queue in one frame.
        if (!(ev?.type === 'run_end' && finalAnswerStarted)) textStreamer.flushImmediate();
        thinkingStreamer.flushImmediate();
      }
      state.applyAgentEvent(ev);
      sync();
    },
    onError: (m) => {
      errorMessage = m;
    },
    onDone: () => {},
  });

  if (finalAnswerStarted && !opts.signal.aborted) await textStreamer.finish();
  else textStreamer.flushImmediate();
  thinkingStreamer.flushImmediate();
  state.finish(opts.signal.aborted ? 'aborted' : errorMessage ? 'error' : undefined);
  const snap = state.snapshot();
  opts.onFinish(snap, errorMessage, snap.agentRun?.stopReason);
}
