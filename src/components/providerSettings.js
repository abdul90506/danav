/** Provider edit helpers shared with the server settings regression tests. */
export function buildEditedProvider(provider, fields) {
  const next = {
    ...provider,
    name: String(fields.name || '').trim(),
    baseUrl: String(fields.baseUrl || '').trim(),
    apiType: fields.apiType,
    models: (Array.isArray(fields.models) ? fields.models : []).map((model) => ({ ...model, providerId: provider.id })),
  };
  delete next.apiKey;
  delete next.clearApiKey;

  const enteredKey = typeof fields.apiKey === 'string' ? fields.apiKey.trim() : '';
  if (enteredKey) {
    next.apiKey = enteredKey;
    next.apiKeyConfigured = true;
  } else if (fields.clearSavedApiKey === true) {
    next.apiKey = '';
    next.apiKeyConfigured = false;
    next.clearApiKey = true;
  } else {
    next.apiKeyConfigured = Boolean(provider.apiKeyConfigured || (typeof provider.apiKey === 'string' && provider.apiKey.trim()));
  }

  return next;
}
