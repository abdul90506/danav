/** Provider edit helpers shared with the server settings regression tests. */

/**
 * Read a plain-text list of API keys.
 *
 * Deliberately forgiving about the file, because the lists people actually
 * keep have blank lines, a trailing newline, commas, quotes and `#` comments
 * in them — and none of those is a reason to make someone re-type eight keys.
 * Duplicates are dropped, order is kept, because keys are tried in order.
 */
export function parseKeyFile(text) {
  const seen = new Set();
  const keys = [];
  // Lines first, THEN commas: a comment is a whole line, and "# keys, exported
  // today" must not leave "exported today" behind as if it were a credential.
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    for (const part of trimmed.split(',')) {
      const key = part.trim().replace(/^["']+|["']+$/g, '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
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
