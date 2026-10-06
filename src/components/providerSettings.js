/** Provider edit helpers shared with the server settings regression tests. */
export function buildEditedProvider(provider, fields) {
  const next = {
    ...provider,
    name: String(fields.name || '').trim(),
    baseUrl: String(fields.baseUrl || '').trim(),
    apiType: fields.apiType,
    models: (Array.isArray(fields.models) ? fields.models : []).map((model) => ({ ...model, providerId: provider.id })),
  };
  if (fields.quota && fields.quota.enabled) {
    const rpm = Math.floor(Number(fields.quota.rpm));
    const rpd = Math.floor(Number(fields.quota.rpd));
    const limit = {};
    if (Number.isFinite(rpm) && rpm > 0) limit.rpm = rpm;
    if (Number.isFinite(rpd) && rpd > 0) limit.rpd = rpd;
    next.quota = { enabled: true, limits: { '*': limit } };
  } else {
    next.quota = { enabled: false };
  }
  delete next.apiKey;
  delete next.apiKeys;
  delete next.apiKeyAdditions;
  delete next.clearApiKey;
  delete next.clearApiKeys;

  const additions = Array.isArray(fields.apiKeys)
    ? [...new Set(fields.apiKeys.filter((key) => typeof key === 'string').map((key) => key.trim()).filter(Boolean))]
    : [];
  if (additions.length) next.apiKeyAdditions = additions;
  if (fields.clearSavedApiKeys === true) next.clearApiKeys = true;
  const currentCount = Number.isFinite(provider.apiKeyCount)
    ? Math.max(0, Math.floor(provider.apiKeyCount || 0))
    : Number(Boolean(provider.apiKeyConfigured || (typeof provider.apiKey === 'string' && provider.apiKey.trim())));
  next.apiKeyCount = fields.clearSavedApiKeys === true ? additions.length : currentCount + additions.length;
  next.apiKeyConfigured = next.apiKeyCount > 0;

  return next;
}
