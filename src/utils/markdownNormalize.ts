/**
 * Turns the inline HTML that models sprinkle into their prose into real
 * markdown, and removes the rest of the HTML vocabulary.
 *
 * The bug this fixes: an agent finished a build and wrote
 *
 *     <strong>✅ Project Complete!</strong>
 *
 * in its final message. react-markdown does not render raw HTML — it escapes
 * it — so the user saw the literal text `<strong>✅ Project Complete!</strong>`
 * in the chat.
 *
 * Why not just add rehype-raw? Because model output is untrusted: rendering it
 * as HTML would let `<img onerror=…>` or `<script>` from a model (or from a
 * file the model read) execute inside the app, and would let arbitrary markup
 * fight the chat's own styles. Translating the handful of tags models actually
 * use is both safer and predictable.
 *
 * Code is never touched — fenced blocks and inline spans are skipped, so a code
 * sample that legitimately contains `<div>` survives intact.
 */

type Replacer = string | ((substring: string, ...args: any[]) => string);

/**
 * A fenced block or an inline code span. Used with String.split, which emits
 * the captures at odd indices — those are the parts we must not touch.
 */
const CODE_SEGMENT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

/** Tags with a direct markdown equivalent. None of these create a `code` span. */
const INLINE_CONVERSIONS: Array<[RegExp, Replacer]> = [
  [/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, '**$1**'],
  [/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, '*$1*'],
  [/<\s*(?:del|s|strike)\s*>([\s\S]*?)<\s*\/\s*(?:del|s|strike)\s*>/gi, '~~$1~~'],
  // <u> has no GFM equivalent — keep the text, drop the emphasis.
  [/<\s*u\s*>([\s\S]*?)<\s*\/\s*u\s*>/gi, '$1'],
  [/<\s*mark\s*>([\s\S]*?)<\s*\/\s*mark\s*>/gi, '**$1**'],
  [/<\s*br\s*\/?\s*>/gi, '\n'],
  [/<\s*hr\s*\/?\s*>/gi, '\n\n---\n\n'],
];

/**
 * `<code>…</code>` → a backtick span. Runs FIRST, and every later pass re-splits
 * on code, so nothing ever rewrites the contents of the span it creates.
 */
const CODE_CONVERSION: [RegExp, Replacer] = [
  /<\s*(?:code|kbd|samp|tt)\s*>([\s\S]*?)<\s*\/\s*(?:code|kbd|samp|tt)\s*>/gi,
  '`$1`',
];

/** `<a href="url">text</a>` -> `[text](url)`. Handles single and double quotes. */
const ANCHOR_RE = /<\s*a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi;

/** Block-level tags become paragraph breaks / headings / list items. */
const BLOCK_CONVERSIONS: Array<[RegExp, Replacer]> = [
  [/<\s*\/\s*(?:p|div|section|article|header|footer|main|aside|figure|figcaption|blockquote|details|summary)\s*>/gi, '\n\n'],
  [/<\s*(?:p|div|section|article|header|footer|main|aside|figure|figcaption|blockquote|details|summary)\b[^>]*>/gi, '\n\n'],
  [
    /<\s*h([1-6])\b[^>]*>([\s\S]*?)<\s*\/\s*h\1\s*>/gi,
    (_m: string, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${String(inner).trim()}\n\n`,
  ],
  [/<\s*li\b[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_m: string, inner: string) => `\n- ${String(inner).trim()}`],
  [/<\s*\/?\s*(?:ul|ol)\b[^>]*>/gi, '\n'],
  [/<\s*\/?\s*(?:table|thead|tbody|tfoot|tr)\b[^>]*>/gi, '\n'],
  [/<\s*(?:td|th)\b[^>]*>/gi, ' | '],
];

/**
 * The HTML vocabulary we are confident is markup rather than a type parameter
 * or a custom element. Anything outside this list (e.g. `<T>`, `<MyWidget>`) is
 * left alone — stripping it could delete real content.
 */
const HTML_TAG_RE =
  /<\s*\/?\s*(?:html|head|body|div|span|p|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|section|article|header|footer|nav|main|aside|figure|figcaption|blockquote|pre|hr|br|img|a|button|input|form|label|select|option|optgroup|textarea|fieldset|legend|svg|path|circle|ellipse|rect|line|polyline|polygon|g|defs|use|symbol|script|style|link|meta|title|iframe|video|audio|source|track|canvas|strong|b|em|i|u|s|del|ins|code|kbd|samp|var|small|sub|sup|time|abbr|cite|q|dfn|wbr|address|mark|dialog|template|noscript|picture)\b[^>]*\/?>/gi;

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&hellip;': '\u2026',
  '&times;': '\u00d7',
  '&check;': '\u2713',
  '&rarr;': '\u2192',
  '&larr;': '\u2190',
};

const ENTITY_RE = /&(?:amp|quot|#39|apos|nbsp|mdash|ndash|hellip|times|check|rarr|larr);/g;

/** True when the text contains something that looks like an HTML tag. */
export const hasHtmlTags = (text: string): boolean => /<\/?[a-zA-Z][^>]*>/.test(text);

/** A marker that can never occur in model output, so code spans stay opaque. */
const CODE_SLOT = '\u0000';

function convertProseSegment(segment: string): string {
  // 1. Pull every <code>/<kbd>/<samp>/<tt> span out first and stand a marker in
  //    its place. The markers make the spans invisible to the passes below,
  //    which is what keeps a literal <strong> written INSIDE a code sample from
  //    being rewritten to **.
  //
  //    The markers also let a tag that SPANS a code sample still convert:
  //    `<strong>bold <code>x</code> too</strong>` becomes
  //    `**bold <marker> too**`, so the bold survives.
  const codeSpans: string[] = [];
  const withCode = segment.replace(CODE_CONVERSION[0], (_m, inner: string) => {
    codeSpans.push('`' + inner + '`');
    return `${CODE_SLOT}${codeSpans.length - 1}${CODE_SLOT}`;
  });

  // 2. Inline emphasis, anchors, block tags and the leftover-HTML strip — all on
  //    a string with no code in it.
  let out = withCode;
  for (const [re, replacement] of INLINE_CONVERSIONS) out = out.replace(re, replacement as any);
  out = out.replace(ANCHOR_RE, '[$2]($1)');
  for (const [re, replacement] of BLOCK_CONVERSIONS) out = out.replace(re, replacement as any);
  out = out.replace(HTML_TAG_RE, '');

  // 3. Put the real code spans back.
  out = out.replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'), (_m, i: string) => codeSpans[Number(i)] ?? '');

  // Collapse the blank runs those removals leave behind, but keep paragraph
  // separation (a single blank line).
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Normalise inline HTML and common entities in a markdown string.
 *
 * Code — fenced blocks and inline spans — is passed through untouched.
 */
export function normalizeMessageContent(text: string): string {
  if (!text) return text;

  // ENTITY_RE is global, so reset before every use — a stale lastIndex makes
  // .test() return false for a string that does contain an entity.
  ENTITY_RE.lastIndex = 0;
  const hasEntity = ENTITY_RE.test(text);
  ENTITY_RE.lastIndex = 0;

  if (!hasHtmlTags(text) && !hasEntity) return text;

  return text
    .split(CODE_SEGMENT_RE)
    .map((segment, index) => {
      // Odd indices are the captured code segments — never touch them.
      if (index % 2 === 1) return segment;
      const converted = convertProseSegment(segment);
      return converted.replace(ENTITY_RE, (m) => ENTITY_MAP[m] ?? m);
    })
    .join('');
}
