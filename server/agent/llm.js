/**
 * One streamed round with an OpenAI-compatible provider, tool-calling aware.
 *
 * Differences from a plain chat round:
 *   - tool-call deltas are surfaced AS THEY ARRIVE (`onToolDelta`), so the chat
 *     can show "Creating index.html +37" growing while the model is still writing
 *   - transient failures (429 / 5xx / dropped connection before the first byte)
 *     are retried with backoff — an agent run is far too long to die on a blip
 *   - a provider that rejects the thinking parameters is retried without them
 */
import { createStreamSplitter } from '../streamSplitter.js';
import { modelForProvider, normalizeThinkingLevel, thinkingParams } from './thinking.js';

export class LlmError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

const normalizeBaseUrl = (url) => String(url || '').trim().replace(/\/+$/, '');
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });

/** Base of the retry backoff (ms). Overridable so tests don't wait half a minute. */
const retryBaseMs = () => (Number(process.env.DANAV_LLM_RETRY_BASE_MS) > 0 ? Number(process.env.DANAV_LLM_RETRY_BASE_MS) : 2000);

export const maxTokens = () => (Number(process.env.DANAV_MAX_TOKENS) > 0 ? Number(process.env.DANAV_MAX_TOKENS) : 32768);

function errorMessageFrom(status, text, model) {
  let msg = `Provider error (HTTP ${status})`;
  try {
    const parsed = JSON.parse(text);
    msg = parsed.error?.message || parsed.message || msg;
  } catch {
    if (text && text.length < 240) msg = text;
  }
  if (status === 401 || status === 403) return 'The provider rejected the API key. Check it in Settings.';
  if (status === 404) return `Model "${model}" or the endpoint was not found on the provider. Check provider settings.`;
  if (status === 429) return `The provider is rate-limiting or out of quota: ${msg}`;
  return msg;
}

/**
 * @param {object} o
 * @param {{ baseUrl: string, apiKey?: string }} o.provider
 * @param {Array} o.messages OpenAI-format messages
 * @param {Array} o.tools    OpenAI tool schemas
 * @param {(text: string) => void} o.onText
 * @param {(text: string) => void} o.onThinking
 * @param {(index: number, slot: {id:string,name:string,args:string}) => void} o.onToolDelta
 * @param {(info: {attempt:number, delayMs:number, reason:string}) => void} [o.onRetry]
 */
export async function streamCompletion({
  provider, model, thinkingLevel, messages, tools, signal, onText, onThinking, onToolDelta, onRetry, maxOutputTokens,
}) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!baseUrl) throw new LlmError('The provider has no Base URL. Set one in Settings.');
  const endpoint = `${baseUrl}/chat/completions`;
  const requestModel = modelForProvider(baseUrl, model);
  const normalizedLevel = normalizeThinkingLevel(thinkingLevel);
  const configuredThinking = thinkingParams({ model: requestModel, baseUrl, level: normalizedLevel });
  const hasThinkingConfig = Object.keys(configuredThinking).length > 0;
  const tokenLimit = Number.isFinite(maxOutputTokens)
    ? Math.max(256, Math.min(maxTokens(), Math.floor(maxOutputTokens)))
    : maxTokens();
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${String(provider.apiKey).trim()}`;

  const build = (withThinking) => {
    const body = { model: requestModel, messages, stream: true, max_tokens: tokenLimit };
    // A wrap-up round passes no tools at all, so the model has to answer in words.
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (withThinking) Object.assign(body, configuredThinking);
    return body;
  };

  // ---- open the stream (retrying whatever is retryable) --------------------
  let withThinking = hasThinkingConfig;
  let upstream = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(build(withThinking)), signal });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (attempt === maxAttempts) throw new LlmError(`Could not reach the provider: ${err?.cause?.code || err?.message || 'network error'}`);
      const delayMs = Math.round(retryBaseMs() * 0.75) * attempt * attempt;
      onRetry?.({ attempt, delayMs, reason: 'connection problem' });
      await sleep(delayMs, signal);
      continue;
    }
    if (res.ok) {
      upstream = res;
      break;
    }

    const text = await res.text().catch(() => '');
    if (res.status === 400 && withThinking) {
      if (normalizedLevel !== 'Auto') {
        if (Array.isArray(tools) && tools.length > 0 && /tool|function/i.test(text)) {
          throw new LlmError(`This model or provider rejected tool calling, which Agent mode needs. Pick a model that supports tool calling. (${errorMessageFrom(400, text, model)})`, { status: 400, code: 'no_tools' });
        }
        const detail = errorMessageFrom(400, text, model);
        throw new LlmError(`The provider rejected the selected ${normalizedLevel} thinking effort. Danav did not lower or remove it; check that this model and endpoint support that level. (${detail})`, { status: 400, code: 'thinking_unsupported' });
      }
      // Auto has no requested effort to preserve. Retry without optional thought
      // summaries if a compatible endpoint rejects that display-only parameter.
      withThinking = false;
      attempt--;
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : retryBaseMs() * attempt * attempt;
      onRetry?.({ attempt, delayMs, reason: res.status === 429 ? 'rate limited' : `provider error ${res.status}` });
      await sleep(delayMs, signal);
      continue;
    }
    if (res.status === 400 && /tool|function/i.test(text)) {
      throw new LlmError(`This model or provider does not support tool calling, which Agent mode needs. Pick a different model. (${errorMessageFrom(400, text, model)})`, { status: 400, code: 'no_tools' });
    }
    throw new LlmError(errorMessageFrom(res.status, text, model), { status: res.status });
  }
  if (!upstream) throw new LlmError('The provider did not answer.');

  // ---- read it ---------------------------------------------------------------
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const splitDelta = createStreamSplitter();
  let buffer = '';
  let text = '';
  let thinking = '';
  let finishReason = null;
  let usage = null;
  const slots = [];
  const byIndex = new Map();

  const emit = (events) => {
    for (const ev of events) {
      if (ev.content) {
        text += ev.content;
        onText?.(ev.content);
      }
      if (ev.thinking) {
        thinking += ev.thinking;
        onThinking?.(ev.thinking);
      }
    }
  };

  const handleChunk = (parsed) => {
    if (parsed.error) throw new LlmError(parsed.error.message || 'The provider stopped mid-answer.');
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;

    const reasoning = delta.reasoning_content || delta.reasoning || delta.thought || delta.thinking;
    if (reasoning) emit([{ thinking: String(reasoning) }]);

    if (delta.extra_content?.google?.thought === true) {
      const t = (delta.content || '').replace(/<\/?thought>/gi, '');
      if (t) emit([{ thinking: t }]);
    } else if (delta.content) {
      emit(splitDelta(delta.content));
    }

    for (const call of delta.tool_calls || []) {
      const idx = call.index ?? 0;
      let slot = byIndex.get(idx);
      // Gemini (and some proxies) reuse index 0 for parallel calls: a NEW id means a new call.
      if (slot && call.id && slot.id && call.id !== slot.id) slot = null;
      if (!slot) {
        slot = { id: call.id || '', name: '', args: '', extra_content: null };
        slots.push(slot);
        byIndex.set(idx, slot);
      }
      if (call.id && !slot.id) slot.id = call.id;
      // Gemini's thought_signature must be echoed back verbatim with the tool result.
      if (call.extra_content) slot.extra_content = call.extra_content;
      const name = call.function?.name;
      if (name) {
        if (!slot.name) slot.name = name;
        else if (name !== slot.name && !slot.name.endsWith(name)) slot.name += name;
      }
      if (call.function?.arguments) slot.args += call.function.arguments;
      onToolDelta?.(slots.indexOf(slot), slot);
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // partial chunk
    }
    handleChunk(parsed);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    if (err instanceof LlmError) throw err;
    throw new LlmError(`The connection to the provider dropped mid-answer: ${err?.message || 'stream error'}`, { code: 'stream_dropped' });
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  emit(splitDelta.flush());

  return { text, thinking, toolCalls: slots, finishReason, usage };
}
