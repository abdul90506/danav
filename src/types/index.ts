export type Theme = 'light' | 'dark' | 'system';

export type ThinkingLevel = 'Auto' | 'Low' | 'Medium' | 'High';

export type ApiType = 'openai' | 'ollama' | 'gemini' | 'anthropic' | 'mock';

export interface Model {
  id: string;
  name: string;
  providerId: string;
  supportsThinking?: boolean;
  description?: string;
}

/** Background task-note model; null follows the provider/model of the current run. */
export interface AgentSummaryModelSelection {
  providerId: string;
  modelId: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** Legacy single-key or one-shot connection-test credential; never returned by settings. */
  apiKey?: string;
  /** One-shot credentials for a connection test; never persisted in browser storage. */
  apiKeys?: string[];
  /** New saved credentials to append; the server keeps the actual values private. */
  apiKeyAdditions?: string[];
  /** Safe metadata returned by settings; never includes credential values. */
  apiKeyCount?: number;
  apiKeyConfigured?: boolean;
  /** One-shot settings update intents; removed before provider state is persisted. */
  clearApiKey?: boolean;
  clearApiKeys?: boolean;
  apiType: ApiType;
  models: Model[];
  isCustom?: boolean;
  enabled?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  type: 'file' | 'folder' | 'image';
  size: number;
  content?: string;
  previewUrl?: string;
  path?: string;
}

/** Which web tool the model decided to run. */
export type ToolName = 'web_search' | 'image_search' | 'fetch_url' | 'movie_search';

export interface MovieItem {
  id: string;
  title: string;
  media_type: 'movie' | 'tv' | string;
  release_date?: string;
  year?: string;
  overview?: string;
  poster: string;
  url: string;
  score?: string;
}

/** An image returned by `image_search`, rendered inline under the tool card. */
export interface ToolImage {
  title: string;
  url: string;
  thumbnail: string;
  source: string;
}

/**
 * One tool the model ran during a turn.
 *
 * Lives on the assistant message so the chat shows the same research trail the
 * agent used to show: what was searched, whether it worked, and a peek at what
 * came back. `status` is 'running' while the server is still working and 'done'
 * once it has a result (or has honestly failed).
 */
export interface SearchSource {
  /** The host of a real search result, used to request its favicon. */
  domain: string;
  /** Optional publisher label returned alongside that result. */
  name?: string;
}

export interface ToolExecution {
  id: string;
  name: ToolName;
  status: 'running' | 'done';
  /** The query (searches) or URL (fetch) the model chose. */
  query?: string;
  /** Resolved page URL and title, when a fetched page was readable. */
  url?: string;
  title?: string;
  /** Short outcome label for tools that have one (e.g. "Page read"). */
  summary?: string;
  /** A few real publisher hosts, shown as a compact favicon stack for web search. */
  sources?: SearchSource[];
  /** Trimmed tool output, shown when the row is expanded. */
  detail?: string;
  ok?: boolean;
  /** True when the model repeated a call and the earlier result was reused. */
  skipped?: boolean;
  images?: ToolImage[];
  movies?: MovieItem[];
}

// ---------------------------------------------------------------------------
// Agent mode
// ---------------------------------------------------------------------------

export type AgentActionStatus =
  | 'pending' // the model is still writing the tool call
  | 'queued' // written, waiting for the actions before it to finish
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'denied' // the user said no
  | 'blocked'; // the run refused it: the target had never been inspected

export interface AgentDiffLine {
  /** ' ' context, '+' added, '-' removed */
  t: ' ' | '+' | '-';
  n?: number;
  o?: number;
  s: string;
}

export interface AgentDiffHunk {
  newStart: number;
  lines: AgentDiffLine[];
}

/** The server's small summary of what a tool did — never file contents. */
export interface AgentActionResult {
  kind: string;
  ok?: boolean;
  path?: string;
  /** Absolute workspace path, used only to label folder listings clearly in the activity trail. */
  fullPath?: string;
  name?: string;
  from?: string;
  to?: string;
  created?: boolean;
  added?: number;
  removed?: number;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  /** A covered, unchanged range was intentionally omitted from this repeated read. */
  repeated?: boolean;
  ranges?: Array<[number, number]>;
  edits?: number;
  replacements?: number;
  hunks?: AgentDiffHunk[];
  /** A multi-file edit: what happened to each file. */
  changes?: Array<{
    path: string;
    added: number;
    removed: number;
    edits?: number;
    ranges?: Array<[number, number]>;
    hunks?: AgentDiffHunk[];
    totalLines?: number;
  }>;
  language?: string;
  note?: string;
  saved?: boolean;
  replacement?: string;
  fileCount?: number;
  dryRun?: boolean;
  /** A write rescued from a call that was cut off by the output limit. */
  partial?: boolean;
  /**
   * A write whose call lost its path: the body was saved (parked) and the run was
   * told to move it into place. Nothing failed — the row says so.
   */
  recovered?: boolean;
  /** Result of the syntax check run right after a write. */
  check?: { lang: string; ok: boolean; message?: string; path?: string };
  /** Code-index answers: definitions/usages found, or files ranked. */
  definitions?: number;
  references?: number;
  symbols?: number;
  /** Repository history answers (repo_status / repo_history). */
  repo?: boolean;
  branch?: string;
  dirty?: number;
  view?: string;
  blocks?: number;
  /** The project's own checks, run as one call (run_checks). */
  checks?: number;
  passed?: boolean;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  denied?: boolean;
  id?: string;
  pid?: number;
  exited?: boolean;
  reused?: boolean;
  listening?: boolean;
  running?: boolean;
  ports?: number[];
  pattern?: string;
  count?: number;
  files?: number;
  directoryCount?: number;
  cwd?: string;
  query?: string;
  /** Real publisher hosts returned by web_search, never inferred from the query. */
  sources?: SearchSource[];
  url?: string;
  title?: string;
  /** Bounded Markdown excerpt displayed for web searches and fetched pages. */
  markdown?: string;
  port?: number;
  status?: number;
  isDir?: boolean;
  images?: ToolImage[];
  todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** Short user-facing current milestone, shown beside the plan progress. */
  summary?: string;
  /** Verified task facts saved in the private checkpoint, shown when plan details are opened. */
  findings?: string[];
  done?: number;
  total?: number;
}

/** One thing the agent did: edit a file, run a command, search… */
export interface AgentAction {
  id: string;
  tool: string;
  status: AgentActionStatus;
  /** Small, safe arguments for display (path, command, query…). */
  args?: Record<string, any>;
  /**
   * A disk-confirmed snapshot while the tool-argument stream is being written: "+N −M" and the
   * last few lines actually on disk. Gone once the action finishes (the result carries exact totals).
   */
  progress?: { added: number; removed?: number; tail?: string[] };
  result?: AgentActionResult;
  /** Terminal output (bounded). */
  output?: string;
  error?: string;
  approval?: { key: string; command: string } | null;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export interface AgentWorkspace {
  id: string;
  name: string;
  kind: 'sandbox' | 'local';
  root: string;
  autoRun: boolean;
  /** Sandboxes only: pause once idle so a forgotten one stops costing money. */
  autoPause?: boolean;
  sandboxId?: string;
  createdAt?: number;
}

/** The lifecycle of a sandbox as Novita reports it. */
export type SandboxState = 'running' | 'paused' | 'gone';

/** One sandbox in the Novita account — whether or not Danav created it. */
export interface SandboxSummary {
  sandboxId: string;
  state: SandboxState;
  templateId: string | null;
  name: string | null;
  cpuCount: number | null;
  memoryMB: number | null;
  startedAt: number | null;
  /** When Novita will pause it on its own if nothing keeps it alive. */
  endAt: number | null;
  metadata: Record<string, string>;
  /** Created by Danav at some point, even if its workspace is long gone. */
  isDanav: boolean;
  /** A workspace in this app still points at it. */
  managed: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  autoPause: boolean | null;
}

export interface SandboxTotals {
  all: number;
  running: number;
  paused: number;
  /** Running and unclaimed by any workspace: pure waste. */
  orphans: number;
}

/** What the active workspace's own sandbox is doing right now. */
export interface SandboxStatus {
  workspaceId: string;
  sandboxId: string | null;
  state: SandboxState | 'local' | 'none' | 'missing' | 'unknown';
  endAt?: number | null;
  autoPause?: boolean;
}

export interface AgentConfig {
  novita: { configured: boolean; source: 'env' | 'saved' | null };
  local: { workspacesDir: string; allowAnyPath: boolean; platform: string };
  limits: { maxSteps: number; commandTimeoutSeconds: number };
  /** Auto-pause policy, so the UI can explain why a sandbox went to sleep. */
  sandbox: { idlePauseSeconds: number; runGraceSeconds: number; timeoutMinutes: number };
  tools: string[];
}

export interface AgentRunSummary {
  stopReason?: string;
  steps?: number;
  toolCalls?: number;
  durationMs?: number;
  changed?: Array<{ path: string; added: number; removed: number }>;
}

export type MessageBlock =
  | {
      id: string;
      type: 'thinking';
      content: string;
      duration?: number;
      isStillThinking?: boolean;
    }
  | {
      id: string;
      type: 'tool';
      tool: ToolExecution;
    }
  | {
      /** The agent's narration, in order with the actions around it. */
      id: string;
      type: 'text';
      content: string;
      /** A one-line system notice (e.g. "sandbox was recreated"), shown muted. */
      notice?: boolean;
      /** The accepted closing answer, streamed below the live work row. */
      finalAnswer?: boolean;
    }
  | {
      id: string;
      type: 'action';
      action: AgentAction;
    };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinkingContent?: string;
  thinkingDuration?: number;
  createdAt: number;
  error?: string;
  attachments?: Attachment[];
  isGenerating?: boolean;
  toolExecutions?: ToolExecution[];
  blocks?: MessageBlock[];
  /** Produced by an agent run (chronological text + action blocks). */
  agent?: boolean;
  agentRun?: AgentRunSummary;
  /** Transient note while an agent turn runs ("Provider busy — retrying…"). */
  agentStatus?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  selectedProviderId: string;
  selectedModelId: string;
  thinkingLevel: ThinkingLevel;
  isPinned?: boolean;
  /** Agent mode: the model works in a workspace with real tools. */
  agentMode?: boolean;
  agentWorkspaceId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One piece of a multimodal message, in the OpenAI-compatible shape every
 * provider we talk to understands. A plain string is still valid content — the
 * array form is only used when a message actually carries an image.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Text-only, or text plus images. */
export type ChatMessageContent = string | ChatContentPart[];

export interface ChatRequestPayload {
  provider: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    apiType: ApiType;
  };
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: ChatMessageContent;
  }>;
  /** Hand the web tools to the model so it can research on its own. */
  toolsEnabled?: boolean;
}
