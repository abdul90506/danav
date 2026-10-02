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

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
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
export interface ToolExecution {
  id: string;
  name: ToolName;
  status: 'running' | 'done';
  /** The query (searches) or URL (fetch) the model chose. */
  query?: string;
  /** Short outcome label, e.g. "8 results" or "Page read". */
  summary?: string;
  /** Trimmed tool output, shown when the row is expanded. */
  detail?: string;
  ok?: boolean;
  /** True when the model repeated a call and the earlier result was reused. */
  skipped?: boolean;
  images?: ToolImage[];
  movies?: MovieItem[];
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
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  selectedProviderId: string;
  selectedModelId: string;
  thinkingLevel: ThinkingLevel;
  isPinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

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
    content: string;
  }>;
  /** Hand the web tools to the model so it can research on its own. */
  toolsEnabled?: boolean;
}
