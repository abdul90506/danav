/** Shared, provider-aware reasoning configuration for normal chat and Agent mode. */
const LEVELS = new Map([
  ['auto', 'Auto'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
]);

export function normalizeThinkingLevel(value) {
  return LEVELS.get(String(value || 'Auto').trim().toLowerCase()) || 'Auto';
}

export function isGoogleGenerativeLanguageUrl(baseUrl) {
  try {
    return new URL(String(baseUrl || '').trim()).hostname.toLowerCase() === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

/** The Google OpenAI-compatible endpoint expects `gemini-*`, not REST `models/gemini-*`. */
export function modelForProvider(baseUrl, model) {
  const value = String(model ?? '').trim();
  return isGoogleGenerativeLanguageUrl(baseUrl) ? value.replace(/^models\//i, '') : value;
}

/**
 * Build the raw JSON fields for OpenAI-compatible providers.
 *
 * Gemini's Auto mode intentionally leaves its thinking level unset (so the
 * model's own default is respected), but asks for thought summaries so the UI
 * can render the thinking card when Gemini returns one. Explicit levels are
 * never silently remapped to a different effort.
 */
export function thinkingParams({ model, baseUrl, level = 'Auto' } = {}) {
  const normalizedLevel = normalizeThinkingLevel(level);
  const modelId = modelForProvider(baseUrl, model).toLowerCase();
  const isGemini = isGoogleGenerativeLanguageUrl(baseUrl) && /gemini[-_]\d/.test(modelId);

  if (isGemini) {
    const thinking_config = { include_thoughts: true };
    if (normalizedLevel !== 'Auto') {
      if (/gemini[-_]2\.5/.test(modelId)) {
        const budget = { low: 1024, medium: 8192, high: 24576 }[normalizedLevel.toLowerCase()];
        if (budget) thinking_config.thinking_budget = budget;
      } else {
        thinking_config.thinking_level = normalizedLevel.toLowerCase();
      }
    }
    return { extra_body: { google: { thinking_config } } };
  }

  return normalizedLevel === 'Auto' ? {} : { reasoning_effort: normalizedLevel.toLowerCase() };
}
