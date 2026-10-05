/**
 * One streamed round with an OpenAI-compatible provider, tool-calling aware.
 *
 * Differences from a plain chat round:
 *   - tool-call deltas are surfaced AS THEY ARRIVE (`onToolDelta`), so the chat
 *     can show "Creating index.html +37" growing while the model is still writing
 *   - transient failures (429 / 5xx / dropped connection before the first byte)
 *     are retried with backoff — an agent run is far too long to die on a blip
 *   - a provider that rejects the thinking parameters is retried without them
 *   - a connection that drops MID-ANSWER is picked up again: the request is
 *     repeated once and only the part the user has not already read is emitted,
 *     because losing an almost-finished answer (and the rest of the run with it)
 *     is the worst outcome for a long autonomous task
 */
import { createStreamSplitter } from '../streamSplitter.js';
import { isCloudMetadataUrl } from '../publicFetch.js';
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
const MAX_PROVIDER_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 30_000;
const credentialCursors = new Map();
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Base of retry backoff (ms). Overridable so focused tests do not wait. */
const retryBaseMs = () => (Number(process.env.DANAV_LLM_RETRY_BASE_MS) > 0 ? Number(process.env.DANAV_LLM_RETRY_BASE_MS) : 2000);

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

const retryDelayMs = (retry, retryAfter = 0) =>
  Math.min(MAX_RETRY_WAIT_MS, Math.max(retryBaseMs() * (2 ** Math.max(0, retry - 1)), retryAfter));
const retryableStatus = (status) => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
const retryableMessage = (value) => /rate[ _-]?limit|too many requests|overload(?:ed)?|server busy|provider busy|temporar(?:y|ily) unavailable|resource exhausted|capacity|try again later|timed? out|bad gateway|internal server error/i.test(String(value || ''));

function credentialList(provider) {
  const values = Array.isArray(provider?.apiKeys) && provider.apiKeys.length
    ? provider.apiKeys
    : [provider?.apiKey];
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const key = value.trim();
    return key ? [key] : [];
  }))];
}

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
 * @param {() => void} [o.onStreamRestart] the answer is being read again; anything the chat showed for the abandoned attempt should be settled
 */
export async function streamCompletion({
  provider, model, thinkingLevel, messages, tools, signal, onText, onThinking, onToolDelta, onRetry,
  onStreamRestart, maxOutputTokens,
}) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!baseUrl) throw new LlmError('The provider has no Base URL. Set one in Settings.');
  if (isCloudMetadataUrl(baseUrl)) {
    throw new LlmError(
      'That Base URL points at a cloud metadata address, which this app will not call. Point it at your provider\'s real API endpoint.'
    );
  }
  const endpoint = `${baseUrl}/chat/completions`;
  const requestModel = modelForProvider(baseUrl, model);
  const normalizedLevel = normalizeThinkingLevel(thinkingLevel);
  const configuredThinking = thinkingParams({ model: requestModel, baseUrl, level: normalizedLevel });
  const hasThinkingConfig = Object.keys(configuredThinking).length > 0;
  const tokenLimit = Number.isFinite(maxOutputTokens)
    ? Math.max(256, Math.min(maxTokens(), Math.floor(maxOutputTokens)))
    : maxTokens();
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
  const apiKeys = credentialList(provider);
  const cursorKey = `${String(provider.id || '')}\n${baseUrl}`;
  let credentialIndex = apiKeys.length ? (credentialCursors.get(cursorKey) || 0) % apiKeys.length : 0;
  let requestCredentialIndex = credentialIndex;
  let retriesUsed = 0;

  const scheduleRetry = async ({ reason, retryAfter = 0, rotateCredential = true }) => {
    if (retriesUsed >= MAX_PROVIDER_RETRIES) return false;
    retriesUsed += 1;
    if (rotateCredential && apiKeys.length) {
      credentialIndex = (credentialIndex + 1) % apiKeys.length;
      credentialCursors.set(cursorKey, credentialIndex);
    }
    const delayMs = retryDelayMs(retriesUsed, retryAfter);
    onRetry?.({
      attempt: retriesUsed,
      maxRetries: MAX_PROVIDER_RETRIES,
      delayMs,
      reason,
      credentialIndex: apiKeys.length ? credentialIndex + 1 : 0,
      credentialCount: apiKeys.length,
    });
    await sleep(delayMs, signal);
    return true;
  };

  const headersForCredential = (credential) => {
    const next = { ...headers };
    if (credential) next.Authorization = `Bearer ${credential}`;
    return next;
  };

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

  // ---- open the stream (retrying provider-busy failures) --------------------
  let withThinking = hasThinkingConfig;
  /** Open (or re-open) the provider stream. */
  const openUpstream = async () => {
    const rejectedCredentials = new Set();
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      requestCredentialIndex = credentialIndex;
      const credential = apiKeys.length ? apiKeys[requestCredentialIndex] : '';
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: headersForCredential(credential),
          body: JSON.stringify(build(withThinking)),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        if (await scheduleRetry({ reason: 'connection problem' })) continue;
        if (apiKeys.length) {
          credentialIndex = (requestCredentialIndex + 1) % apiKeys.length;
          credentialCursors.set(cursorKey, credentialIndex);
        }
        throw new LlmError(`Could not reach the provider: ${err?.cause?.code || err?.message || 'network error'}`);
      }
      if (res.ok) return res;

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
        continue;
      }

      // An invalid saved key should not prevent trying the remaining keys. This
      // credential-only rotation is immediate; it does not consume a busy retry.
      if (res.status !== 401 && res.status !== 403) rejectedCredentials.clear();
      if ((res.status === 401 || res.status === 403) && apiKeys.length > 1 && !rejectedCredentials.has(requestCredentialIndex)) {
        rejectedCredentials.add(requestCredentialIndex);
        if (rejectedCredentials.size < apiKeys.length) {
          credentialIndex = (requestCredentialIndex + 1) % apiKeys.length;
          credentialCursors.set(cursorKey, credentialIndex);
          onRetry?.({
            attempt: retriesUsed,
            maxRetries: MAX_PROVIDER_RETRIES,
            delayMs: 0,
            reason: 'API key rejected; trying another saved key',
            credentialIndex: credentialIndex + 1,
            credentialCount: apiKeys.length,
          });
          continue;
        }
      }

      const retryable = retryableStatus(res.status) || retryableMessage(text);
      if (retryable) {
        const reason = res.status === 429
          ? 'rate limited'
          : res.status >= 500
            ? `provider busy (HTTP ${res.status})`
            : res.status === 408 || res.status === 425
              ? 'provider temporarily unavailable'
              : 'provider busy';
        if (await scheduleRetry({ reason, retryAfter: retryAfterMs(res.headers.get('retry-after')) })) continue;
        if (apiKeys.length) {
          credentialIndex = (requestCredentialIndex + 1) % apiKeys.length;
          credentialCursors.set(cursorKey, credentialIndex);
        }
      }
      if (res.status === 400 && /tool|function/i.test(text)) {
        throw new LlmError(`This model or provider does not support tool calling, which Agent mode needs. Pick a different model. (${errorMessageFrom(400, text, model)})`, { status: 400, code: 'no_tools' });
      }
      if ((res.status === 401 || res.status === 403) && apiKeys.length) {
        credentialIndex = (requestCredentialIndex + 1) % apiKeys.length;
        credentialCursors.set(cursorKey, credentialIndex);
      }
      throw new LlmError(errorMessageFrom(res.status, text, model), { status: res.status });
    }
  };
  let upstream = await openUpstream();

  // ---- read it, and pick it back up if the connection dies ------------------
  //
  // Everything the user has seen so far, and whether the current attempt is
  // being buffered instead of shown (a retry must not repeat what was read).
  const emitted = { text: '', thinking: '' };
  let buffering = false;
  const buffered = { text: '', thinking: '' };

  const emitText = (piece) => {
    const s = String(piece ?? '');
    if (!s) return;
    if (buffering) {
      buffered.text += s;
      return;
    }
    emitted.text += s;
    onText?.(s);
  };
  const emitThinking = (piece) => {
    const s = String(piece ?? '');
    if (!s) return;
    if (buffering) {
      buffered.thinking += s;
      return;
    }
    emitted.thinking += s;
    onThinking?.(s);
  };

  let streamedToolDelta = false;
  const forwardToolDelta = (index, slot) => {
    streamedToolDelta = true;
    onToolDelta?.(index, slot);
  };
  const rememberNextCredential = (usedIndex) => {
    if (!apiKeys.length) return;
    credentialIndex = (usedIndex + 1) % apiKeys.length;
    credentialCursors.set(cursorKey, credentialIndex);
  };
  const readWithBusyRetries = async () => {
    for (;;) {
      const usedIndex = requestCredentialIndex;
      try {
        const result = await readStream(upstream, { emitText, emitThinking, onToolDelta: forwardToolDelta });
        rememberNextCredential(usedIndex);
        return result;
      } catch (err) {
        const hasOutput = Boolean(emitted.text || emitted.thinking || streamedToolDelta);
        const isBusy = retryableStatus(err?.status) || retryableMessage(err?.message);
        if (signal?.aborted || hasOutput || !isBusy) throw err;
        const reason = err?.status === 429
          ? 'rate limited'
          : err?.status
            ? `provider busy (HTTP ${err.status})`
            : 'provider busy';
        if (!(await scheduleRetry({ reason, retryAfter: retryAfterMs(upstream?.headers?.get('retry-after')) }))) {
          if (apiKeys.length) {
            credentialIndex = (usedIndex + 1) % apiKeys.length;
            credentialCursors.set(cursorKey, credentialIndex);
          }
          throw err;
        }
        upstream = await openUpstream();
      }
    }
  };

  let round;
  try {
    round = await readWithBusyRetries();
  } catch (err) {
    if (err?.code !== 'stream_dropped' || signal?.aborted || !(emitted.text || emitted.thinking)) throw err;

    // The answer was already being read when the connection died. Ask again —
    // the same request, the same conversation — and show only what is new.
    //
    // Whatever happens next, this round has to end with ANSWER, not with an
    // error: the user has already read half a reply, and the run still has work
    // to do. So every failure below falls back to the part that arrived.
    const keepWhatArrived = () => {
      buffering = false;
      emitText('\n\n_[The connection to the provider dropped while this was being written. Ask again to continue from here.]_');
      return { text: emitted.text, thinking: emitted.thinking, toolCalls: [], finishReason: 'dropped', usage: null };
    };
    onRetry?.({ attempt: 1, delayMs: 0, reason: 'the answer was cut off' });
    onStreamRestart?.();
    buffering = true;
    let retried = null;
    let retryUpstream = null;
    try {
      retryUpstream = await openUpstream();
      retried = await readStream(retryUpstream, { emitText, emitThinking });
      rememberNextCredential(requestCredentialIndex);
    } catch (retryErr) {
      if (retryErr?.name === 'AbortError' || signal?.aborted) throw retryErr;
      // Unreachable as well? Then there is nothing more to ask for.
      return keepWhatArrived();
    }

    // Only the tail beyond the longest shared prefix is new. A model that
    // retypes the same opening words (usual at low temperature) leaves nothing
    // duplicated; one that takes a different road leaves a visible join, which
    // is still better than losing the answer and the run with it.
    const sharedPrefix = (a, b) => {
      const max = Math.min(a.length, b.length);
      let i = 0;
      while (i < max && a[i] === b[i]) i += 1;
      return i;
    };
    const freshThinking = buffered.thinking.slice(sharedPrefix(emitted.thinking, buffered.thinking));
    const freshText = buffered.text.slice(sharedPrefix(emitted.text, buffered.text));
    buffering = false;
    if (freshThinking) {
      emitted.thinking += freshThinking;
      onThinking?.(freshThinking);
    }
    if (freshText) {
      emitted.text += freshText;
      onText?.(freshText);
    }
    round = { ...retried, text: emitted.text, thinking: emitted.thinking };
  }

  return round;
}

/**
 * Read one SSE answer from an open provider response.
 *
 * Split out of `streamCompletion` so a dropped connection can be picked up
 * without rebuilding the request by hand: the caller tries again and decides
 * what is genuinely new.
 */
async function readStream(upstream, { emitText, emitThinking, onToolDelta }) {
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
        emitText(ev.content);
      }
      if (ev.thinking) {
        thinking += ev.thinking;
        emitThinking(ev.thinking);
      }
    }
  };

  const handleChunk = (parsed) => {
    if (parsed.error) {
      const providerError = parsed.error;
      const status = Number(providerError?.status);
      const message = typeof providerError === 'string' ? providerError : providerError?.message;
      throw new LlmError(message || 'The provider stopped mid-answer.', {
        status: Number.isFinite(status) && status > 0 ? status : undefined,
        code: providerError?.code ? String(providerError.code) : undefined,
      });
    }
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
    // A client abort is not a provider problem, and a provider-sent error is
    // already explained — only a dead connection is retryable.
    if (err?.name === 'AbortError') throw err;
    if (err instanceof LlmError) throw err;
    throw new LlmError(`The connection to the provider dropped mid-answer: ${err?.message || 'stream error'}`, { code: 'stream_dropped' });
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  emit(splitDelta.flush());

  return { text, thinking, toolCalls: slots, finishReason, usage };
}
