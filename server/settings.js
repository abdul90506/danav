/** Pure helpers for keeping provider credentials on the backend settings store. */

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/, '');
const MAX_API_KEY_CHARS = 8192;

/** Normalise stored, legacy, or one-shot credentials without ever exposing them. */
export function providerApiKeys(provider) {
  if (!isObject(provider)) return [];
  const raw = Array.isArray(provider.apiKeys) && provider.apiKeys.length
    ? provider.apiKeys
    : [provider.apiKey];
  const seen = new Set();
  return raw.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const key = value.trim();
    if (!key || key.length > MAX_API_KEY_CHARS || seen.has(key)) return [];
    seen.add(key);
    return [key];
  });
}

function cleanKeyList(value) {
  return providerApiKeys({ apiKeys: Array.isArray(value) ? value : [] });
}

/** The browser may select a configured summary model, but never a credential or arbitrary endpoint. */
export function normalizeAgentSummaryModel(selection, providers) {
  if (!isObject(selection)) return null;
  const providerId = typeof selection.providerId === 'string' ? selection.providerId.trim() : '';
  const modelId = typeof selection.modelId === 'string' ? selection.modelId.trim() : '';
  if (!providerId || !modelId) return null;
  const provider = (Array.isArray(providers) ? providers : []).find((item) =>
    isObject(item) && String(item.id || '') === providerId && item.enabled !== false && item.apiType !== 'mock' && normalizeUrl(item.baseUrl)
  );
  if (!provider || !Array.isArray(provider.models)) return null;
  return provider.models.some((model) => isObject(model) && String(model.id || '') === modelId)
    ? { providerId, modelId }
    : null;
}

/** Resolve the saved selection with its own provider credentials, or use this task's model. */
export function resolveAgentSummaryModel(settings, fallbackProvider, fallbackModel) {
  const selection = normalizeAgentSummaryModel(settings?.agentSummaryModel, settings?.providers);
  if (!selection) return { provider: fallbackProvider, model: fallbackModel, selected: false };
  const stored = settings.providers.find((item) => String(item?.id || '') === selection.providerId);
  return {
    provider: resolveConfiguredProvider({ id: stored.id, baseUrl: stored.baseUrl, apiType: stored.apiType }, settings),
    model: selection.modelId,
    selected: true,
  };
}

/**
 * Merge a partial settings update without losing API keys when the browser sends
 * the intentionally key-free provider objects returned by `publicSettings`.
 * Saved API-key lists survive ordinary edits. New keys are appended only by
 * explicit apiKeyAdditions, and saved credentials are removed only by the
 * provider editor's explicit clear intent. The legacy single-key fields remain
 * readable so older local settings migrate without losing credentials.
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
    // An entry that is not an object, or has no id, cannot be stored or matched
    // against a stored key — keeping it would write a provider the UI can never
    // open (`{ id: 5 }` used to replace a real one this way).
    updated.providers = delta.providers.filter((provider) => isObject(provider) && String(provider.id || '').trim()).map((provider) => {
      const previous = previousById.get(String(provider.id || ''));
      const next = { ...provider };
      const legacyReplacement = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
      const clearKeys = provider.clearApiKeys === true || provider.clearApiKey === true;
      let keys = clearKeys ? [] : providerApiKeys(previous);
      if (Array.isArray(provider.apiKeyAdditions)) {
        keys = cleanKeyList([...keys, ...provider.apiKeyAdditions]);
      } else if (Array.isArray(provider.apiKeys)) {
        // A key-free partial/public provider shape must not erase saved values;
        // clearing requires explicit intent. A non-empty legacy key still keeps
        // the old client's one-key replacement behavior.
        if (provider.apiKeys.length > 0 || clearKeys) keys = cleanKeyList(provider.apiKeys);
        else if (legacyReplacement) keys = cleanKeyList([legacyReplacement]);
      } else if (!clearKeys && legacyReplacement) {
        // Older clients had one editable key field; preserve that replace intent.
        keys = cleanKeyList([legacyReplacement]);
      }
      next.apiKeys = keys;
      delete next.apiKey;
      delete next.apiKeyAdditions;
      delete next.clearApiKey;
      delete next.clearApiKeys;
      delete next.apiKeyConfigured;
      delete next.apiKeyCount;

      // These are read as strings all over the app (`url.trim()`, `model.id`).
      // Coerce primitives, and drop anything that cannot be one.
      for (const key of ['id', 'name', 'baseUrl', 'apiType']) {
        next[key] = typeof next[key] === 'string' ? next[key] : String(next[key] ?? '');
      }
      next.models = (Array.isArray(next.models) ? next.models : [])
        .filter((model) => isObject(model) && String(model.id || '').trim())
        .map((model) => ({
          ...model,
          id: String(model.id),
          name: typeof model.name === 'string' ? model.name : String(model.name ?? model.id),
          providerId: String(model.providerId || next.id),
        }));
      // Request budgeting. A patch that says nothing about quota keeps what was
      // saved — a client that predates the feature must not silently disable it.
      next.quota = Object.hasOwn(provider, 'quota') ? normalizeQuota(provider.quota) : (previous?.quota || undefined);
      if (!next.quota) delete next.quota;
      return next;
    });
  }

  updated.agentSummaryModel = normalizeAgentSummaryModel(
    Object.hasOwn(delta, 'agentSummaryModel') ? delta.agentSummaryModel : base.agentSummaryModel,
    updated.providers
  );
  return updated;
}

/**
 * Per-model request limits, cleaned.
 *
 * Limits are whole positive numbers or they are not limits. A zero or a string
 * would make the planner think a model is permanently exhausted, so anything
 * that is not a usable number is dropped and the documented default applies.
 */
function normalizeQuota(raw) {
  if (!isObject(raw)) return undefined;
  const limits = {};
  for (const [model, value] of Object.entries(isObject(raw.limits) ? raw.limits : {})) {
    const key = String(model || '').trim();
    if (!key || !isObject(value)) continue;
    const entry = {};
    for (const field of ['rpm', 'rpd']) {
      const n = Math.floor(Number(value[field]));
      if (Number.isFinite(n) && n > 0) entry[field] = n;
    }
    if (Object.keys(entry).length) limits[key] = entry;
  }
  return { enabled: raw.enabled === true, ...(Object.keys(limits).length ? { limits } : {}) };
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
        apiKeyConfigured: providerApiKeys(provider).length > 0,
        apiKeyCount: providerApiKeys(provider).length,
        ...(isObject(provider.quota) ? { quota: normalizeQuota(provider.quota) } : {}),
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
    agentSummaryModel: normalizeAgentSummaryModel(value.agentSummaryModel, value.providers),
  };
}

/** Resolve a key stored for this provider, but never send it to a different URL. */
export function resolveConfiguredProvider(provider, settings) {
  if (!isObject(provider)) return provider;
  const id = typeof provider.id === 'string' ? provider.id : '';
  const clearKeys = provider.clearApiKeys === true || provider.clearApiKey === true;
  const stored = (Array.isArray(settings?.providers) ? settings.providers : [])
    .find((candidate) => isObject(candidate) && String(candidate.id || '') === id);
  if (!stored) {
    if (!clearKeys) return provider;
    const suppliedKeys = cleanKeyList(provider.apiKeys);
    return { ...provider, apiKeys: suppliedKeys, apiKey: suppliedKeys[0] || '' };
  }

  const suppliedKeys = clearKeys
    ? cleanKeyList(provider.apiKeys)
    : providerApiKeys(provider);
  const incomingUrl = normalizeUrl(provider.baseUrl);
  const storedUrl = normalizeUrl(stored.baseUrl);
  const sameEndpoint = (!incomingUrl || incomingUrl === storedUrl)
    && (!provider.apiType || !stored.apiType || provider.apiType === stored.apiType);
  const storedKeys = sameEndpoint ? providerApiKeys(stored) : [];
  const noCredentials = { ...provider, apiKey: '', apiKeys: [] };

  // Explicit one-shot keys are tried after this endpoint's saved list, unless
  // the editor asked to clear saved credentials. A changed endpoint must never
  // inherit a provider's stored keys.
  if (clearKeys) return { ...provider, apiKeys: suppliedKeys, apiKey: suppliedKeys[0] || '' };
  if (suppliedKeys.length) {
    const keys = [...new Set([...storedKeys, ...suppliedKeys])];
    return { ...provider, apiKeys: keys, apiKey: keys[0] || '' };
  }
  if (!sameEndpoint) return noCredentials;
  return {
    ...provider,
    baseUrl: stored.baseUrl || provider.baseUrl,
    apiType: stored.apiType || provider.apiType,
    apiKeys: storedKeys,
    apiKey: storedKeys[0] || '',
  };
}
