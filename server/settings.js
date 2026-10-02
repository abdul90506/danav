/** Pure helpers for keeping provider credentials on the backend settings store. */

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

/**
 * Merge a partial settings update without losing API keys when the browser sends
 * the intentionally key-free provider objects returned by `publicSettings`.
 * A key is replaced only when a non-empty new value is supplied, and removed
 * only by the explicit clearApiKey intent from the provider editor.
 */
export function mergeSettingsPatch(current, patch) {
  const base = isObject(current) ? current : {};
  const delta = isObject(patch) ? patch : {};
  const updated = { ...base, ...delta };

  if (Array.isArray(delta.providers)) {
    const previousById = new Map(
      (Array.isArray(base.providers) ? base.providers : [])
        .filter(isObject)
        .map((provider) => [String(provider.id || ''), provider])
    );
    updated.providers = delta.providers.filter(isObject).map((provider) => {
      const previous = previousById.get(String(provider.id || ''));
      const next = { ...provider };
      const replacement = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
      if (provider.clearApiKey === true) next.apiKey = '';
      else if (replacement) next.apiKey = replacement;
      else next.apiKey = typeof previous?.apiKey === 'string' ? previous.apiKey : '';
      delete next.clearApiKey;
      delete next.apiKeyConfigured;
      return next;
    });
  }

  return updated;
}

/** The only settings shape safe to return to the browser. */
export function publicSettings(settings) {
  const value = isObject(settings) ? settings : {};
  const publicProviders = Array.isArray(value.providers)
    ? value.providers.filter(isObject).map((provider) => ({
        id: String(provider.id || ''),
        name: String(provider.name || ''),
        baseUrl: String(provider.baseUrl || ''),
        apiType: String(provider.apiType || 'openai'),
        isCustom: Boolean(provider.isCustom),
        enabled: provider.enabled !== false,
        apiKeyConfigured: Boolean(typeof provider.apiKey === 'string' && provider.apiKey.trim()),
        models: Array.isArray(provider.models) ? provider.models.filter(isObject).map((model) => ({
          id: String(model.id || ''),
          name: String(model.name || model.id || ''),
          providerId: String(model.providerId || provider.id || ''),
          ...(typeof model.supportsThinking === 'boolean' ? { supportsThinking: model.supportsThinking } : {}),
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
        })) : [],
      }))
    : [];

  return {
    providers: publicProviders,
    ...(typeof value.theme === 'string' ? { theme: value.theme } : {}),
    ...(typeof value.lastSelectedProviderId === 'string' ? { lastSelectedProviderId: value.lastSelectedProviderId } : {}),
    ...(typeof value.lastSelectedModelId === 'string' ? { lastSelectedModelId: value.lastSelectedModelId } : {}),
  };
}

/** Resolve a key stored for this provider, but never send it to a different URL. */
export function resolveConfiguredProvider(provider, settings) {
  if (!isObject(provider)) return provider;
  const id = typeof provider.id === 'string' ? provider.id : '';
  const stored = (Array.isArray(settings?.providers) ? settings.providers : [])
    .find((candidate) => isObject(candidate) && String(candidate.id || '') === id);
  if (!stored) return provider;

  const suppliedKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  if (suppliedKey) return { ...provider, apiKey: suppliedKey };

  const incomingUrl = normalizeUrl(provider.baseUrl);
  const storedUrl = normalizeUrl(stored.baseUrl);
  // An empty URL is allowed for routes that can safely use the saved provider;
  // a different non-empty URL is not allowed to inherit its credential.
  if (incomingUrl && incomingUrl !== storedUrl) return { ...provider, apiKey: '' };
  if (provider.apiType && stored.apiType && provider.apiType !== stored.apiType) return { ...provider, apiKey: '' };
  return {
    ...provider,
    baseUrl: stored.baseUrl || provider.baseUrl,
    apiType: stored.apiType || provider.apiType,
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
  };
}
