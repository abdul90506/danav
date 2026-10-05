import type {
  AgentAction,
  AgentRunSummary,
  AgentWorkspace,
  MessageBlock,
} from '../types';

/**
 * The chronological transcript of one agent turn.
 *
 * The server streams text, reasoning and action events in the order the model
 * produced them; this keeps them in exactly that order as blocks:
 *
 *   thinking → text → action → action → text → action → text …
 *
 * so an action and the sentence about it always stay together. Pure TypeScript
 * (no React), so every rule can be tested on its own.
 */

const MAX_OUTPUT = 20_000;

export interface TurnSnapshot {
  blocks: MessageBlock[];
  /** All narration text joined — what Copy and the next turn's history use. */
  content: string;
  thinkingContent?: string;
  agentRun?: AgentRunSummary;
}

const LIVE = new Set(['pending', 'queued', 'running', 'awaiting_approval']);
const clipTail = (s: string, n: number) => (s.length > n ? s.slice(s.length - n) : s);

export class AgentTurnState {
  private blocks: MessageBlock[] = [];
  private content = '';
  private thinking = '';
  private thinkingStartedAt: number | null = null;
  private finalAnswerStarted = false;
  private seq = 0;
  private readonly now: () => number;

  runId?: string;
  workspace?: AgentWorkspace;
  run?: AgentRunSummary;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private nextId(prefix: string) {
    return `${prefix}-${this.seq++}`;
  }

  private last(): MessageBlock | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  private findAction(id: string): number {
    return this.blocks.findIndex((b) => b.type === 'action' && b.action.id === id);
  }

  // ---- streamed text ------------------------------------------------------

  appendText(chunk: string) {
    if (!chunk) return;
    if (this.finalAnswerStarted) {
      this.appendFinalAnswer(chunk);
      return;
    }
    this.markThinkingDone();
    const last = this.last();
    if (last && last.type === 'text' && !last.notice) {
      this.blocks[this.blocks.length - 1] = { ...last, content: last.content + chunk };
      this.content += chunk;
      return;
    }
    // A fresh paragraph after an action: don't open it with the blank lines the model leads with.
    const text = chunk.replace(/^\s+/, '');
    if (!text) return;
    if (this.content && !this.content.endsWith('\n')) this.content += '\n\n';
    this.content += text;
    this.blocks.push({ id: this.nextId('txt'), type: 'text', content: text });
  }

  private appendFinalAnswer(chunk: string) {
    if (!chunk) return;
    this.markThinkingDone();
    const last = this.last();
    if (last && last.type === 'text' && !last.notice && last.finalAnswer) {
      this.blocks[this.blocks.length - 1] = { ...last, content: last.content + chunk };
      this.content += chunk;
      return;
    }
    const text = chunk.replace(/^\s+/, '');
    if (!text) return;
    if (this.content && !this.content.endsWith('\n')) this.content += '\n\n';
    this.content += text;
    this.blocks.push({ id: this.nextId('txt'), type: 'text', content: text, finalAnswer: true });
  }

  appendThinking(chunk: string) {
    if (!chunk) return;
    if (this.thinkingStartedAt === null) this.thinkingStartedAt = this.now();
    this.thinking += chunk;
    const last = this.last();
    if (last && last.type === 'thinking' && last.isStillThinking) {
      this.blocks[this.blocks.length - 1] = { ...last, content: last.content + chunk };
    } else {
      this.blocks.push({ id: this.nextId('think'), type: 'thinking', content: chunk, isStillThinking: true });
    }
  }

  markThinkingDone() {
    if (!this.blocks.some((b) => b.type === 'thinking' && b.isStillThinking)) return;
    const seconds = Math.max(1, Math.round((this.now() - (this.thinkingStartedAt ?? this.now())) / 1000));
    this.blocks = this.blocks.map((b) =>
      b.type === 'thinking' && b.isStillThinking ? { ...b, isStillThinking: false, duration: seconds } : b
    );
    this.thinkingStartedAt = null;
  }

  // ---- agent events -------------------------------------------------------

  applyAgentEvent(ev: any) {
    switch (ev?.type) {
      case 'run_start':
        this.runId = ev.runId;
        this.workspace = ev.workspace;
        break;

      case 'notice':
        this.markThinkingDone();
        if (ev.message) this.blocks.push({ id: this.nextId('note'), type: 'text', content: String(ev.message), notice: true });
        break;

      case 'final_answer_start':
        this.markThinkingDone();
        this.finalAnswerStarted = true;
        break;

      case 'action_start': {
        this.markThinkingDone();
        if (this.findAction(ev.id) >= 0) break;
        const action: AgentAction = {
          id: ev.id,
          tool: ev.tool,
          status: 'pending',
          args: ev.args || {},
          ...(ev.progress ? { progress: ev.progress } : {}),
          startedAt: this.now(),
        };
        this.blocks.push({ id: `blk-${ev.id}`, type: 'action', action });
        break;
      }

      case 'action_update': {
        const i = this.findAction(ev.id);
        if (i < 0) break;
        const block = this.blocks[i] as Extract<MessageBlock, { type: 'action' }>;
        const a: AgentAction = { ...block.action };
        const p = ev.patch || {};
        if (p.status) a.status = p.status;
        if (p.args) a.args = { ...a.args, ...p.args };
        if ('progress' in p) {
          if (p.progress == null) delete a.progress;
          else a.progress = p.progress;
        }
        if (p.outputAppend) a.output = clipTail((a.output || '') + p.outputAppend, MAX_OUTPUT);
        if ('approval' in p) a.approval = p.approval;
        this.blocks[i] = { ...block, action: a };
        break;
      }

      case 'action_end': {
        const i = this.findAction(ev.id);
        if (i < 0) break;
        const block = this.blocks[i] as Extract<MessageBlock, { type: 'action' }>;
        const a: AgentAction = {
          ...block.action,
          status: ev.status,
          result: ev.result,
          error: ev.error,
          durationMs: ev.durationMs,
          endedAt: this.now(),
          approval: null,
        };
        if (ev.output !== undefined) a.output = ev.output;
        delete a.progress;
        this.blocks[i] = { ...block, action: a };
        break;
      }

      case 'run_end':
        this.run = {
          stopReason: ev.stopReason,
          steps: ev.steps,
          toolCalls: ev.toolCalls,
          durationMs: ev.durationMs,
          changed: Array.isArray(ev.changed) ? ev.changed : [],
        };
        this.settle(ev.stopReason);
        break;

      default:
        break;
    }
  }

  /** Anything still spinning when the turn ends (stop, error, lost connection) is settled. */
  settle(reason?: string) {
    this.markThinkingDone();
    this.blocks = this.blocks.map((b) =>
      b.type === 'action' && LIVE.has(b.action.status)
        ? {
            ...b,
            action: {
              ...b.action,
              status: 'error' as const,
              error: reason === 'aborted' ? 'Stopped' : 'Interrupted',
              approval: null,
              progress: undefined,
            },
          }
        : b
    );
  }

  finish(reason?: string) {
    this.settle(reason);
  }

  get hasLiveAction() {
    return this.blocks.some((b) => b.type === 'action' && LIVE.has(b.action.status));
  }

  snapshot(): TurnSnapshot {
    return {
      blocks: this.blocks.slice(),
      content: this.content,
      thinkingContent: this.thinking || undefined,
      agentRun: this.run,
    };
  }
}
