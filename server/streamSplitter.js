/**
 * Streaming thought/content splitter.
 *
 * A provider streams a turn as raw text deltas. Some of that text is the
 * model's private reasoning (wrapped in <thought> / <think>) and some is the
 * visible answer plus tool tags. The UI renders those on two different
 * channels, so they must be separated reliably.
 *
 * Design notes (each one fixes a real bug we hit):
 *
 * 1. TOKENISED, not regex-replaced. We walk the text and emit the gaps between
 *    control tags, so a thought can open or close anywhere in a turn — not just
 *    before the first tool call. A previous "once we see a tool tag, never parse
 *    a thought again" rule meant every reasoning block after the first tool call
 *    leaked into the chat as raw prose.
 *
 * 2. PARTIAL TAGS ARE HELD BACK. A delta can end mid-tag ("<thou"); emitting it
 *    as content would leave a broken tag on screen once the next delta arrives.
 *    A trailing partial token is buffered and re-joined with the next delta.
 *
 * 3. LITERAL TAGS ARE PRESERVED. A "<thought>" that is really data — inside a
 *    fenced code sample, or inside a file the model is writing — is emitted as
 *    content, verbatim, and never opens the Thinking channel.
 *
 * `splitDelta(text)` returns `{ thinking }` / `{ content }` events in emission
 * order. `splitDelta.flush()` releases any held-back partial at end of stream.
 */

const BODY_TOOLS = 'write_file|create_file|edit_file';
const ALL_TOOLS =
  'write_file|create_file|edit_file|read_file|list_dir|run_command|execute_command|' +
  'web_search|image_search|fetch_url|read_url|file_search|grep_search|' +
  'ask_user|run_background|check_background|kill_background';

const THOUGHT_TOKENS = ['<thought>', '<think>', '</thought>', '</think>'];

export function createStreamSplitter() {
  let inThoughtBlock = false;
  let fenceCount = 0;
  let inToolBody = false;
  let carry = '';

  // One pass finds every control tag; everything between them is plain text.
  const TOKEN_RE = new RegExp(
    '<thought>|<think>|</thought>|</think>|' +
      `<(?:${ALL_TOOLS})\\b[^>]*>|` +
      `</(?:${ALL_TOOLS})>`,
    'gi'
  );

  const BODY_OPEN_RE = new RegExp(`^</?(?:${BODY_TOOLS})\\b`, 'i');

  /** Length of a trailing partial thought-token that must wait for more input. */
  function trailingPartial(text) {
    // A COMPLETE token at the end is not a partial — emit it immediately.
    for (const token of THOUGHT_TOKENS) {
      if (text.endsWith(token)) return 0;
    }
    let hold = 0;
    for (const token of THOUGHT_TOKENS) {
      const max = Math.min(token.length - 1, text.length);
      for (let n = max; n > hold; n--) {
        if (text.endsWith(token.slice(0, n))) {
          hold = n;
          break;
        }
      }
    }
    return hold;
  }

  function splitDelta(rawText) {
    const events = [];
    let text = carry + (rawText || '');
    carry = '';

    const hold = trailingPartial(text);
    if (hold > 0) {
      carry = text.slice(text.length - hold);
      text = text.slice(0, text.length - hold);
    }
    if (!text) return events;

    const push = (kind, value) => {
      if (value) events.push({ [kind]: value });
    };

    const handleGap = (gap) => {
      if (!gap) return;
      fenceCount += (gap.match(/```/g) || []).length;
      push(inThoughtBlock ? 'thinking' : 'content', gap);
    };

    const handleToken = (token) => {
      const lower = token.toLowerCase();

      if (lower === '<thought>' || lower === '<think>') {
        // Only real reasoning opens the channel. Inside a fence or a file body
        // the tag is data and must survive verbatim.
        if (fenceCount % 2 === 1 || inToolBody) push('content', token);
        else inThoughtBlock = true;
        return;
      }

      if (lower === '</thought>' || lower === '</think>') {
        if (inThoughtBlock) inThoughtBlock = false;
        else push('content', token); // stray closing tag — keep it visible
        return;
      }

      // Any tool tag ends the current thought.
      inThoughtBlock = false;

      const isClosing = token.startsWith('</');
      const isSelfClosing = /\/>\s*$/.test(token);
      if (BODY_OPEN_RE.test(token)) {
        if (isClosing) inToolBody = false;
        else if (!isSelfClosing) inToolBody = true;
      }

      push('content', token);
    };

    TOKEN_RE.lastIndex = 0;
    let last = 0;
    let match;
    while ((match = TOKEN_RE.exec(text)) !== null) {
      handleGap(text.slice(last, match.index));
      handleToken(match[0]);
      last = match.index + match[0].length;
    }
    handleGap(text.slice(last));

    return events;
  }

  /** Flush a held-back partial when the stream ends. */
  splitDelta.flush = () => {
    const events = [];
    if (carry) {
      events.push({ [inThoughtBlock ? 'thinking' : 'content']: carry });
      carry = '';
    }
    return events;
  };

  return splitDelta;
}
