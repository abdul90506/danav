const TOKEN_KEY = 'danav_preview_access_code';

export function savePreviewAccessCode(code: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(TOKEN_KEY, code);
  } catch {
    // The caller can still retry while the current page remains open.
  }
}

export function clearPreviewAccessCode(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* unavailable storage */
  }
}

export function previewAuthHeaders(): Record<string, string> {
  try {
    const token = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) || '';
    return token ? { 'x-danav-preview-token': token } : {};
  } catch {
    return {};
  }
}

/**
 * The same token, for a request that cannot carry headers.
 *
 * `navigator.sendBeacon` has no headers API, so the pagehide flush — the one
 * save that catches whatever was typed in the last few hundred milliseconds
 * before a reload — arrived at the server unauthenticated and was rejected
 * with a 401. Silently: an unload has nowhere to report to. On a preview with
 * an access code that meant a refresh really could swallow the last message.
 */
export function previewAuthQuery(): string {
  try {
    const token = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) || '';
    return token ? `?token=${encodeURIComponent(token)}` : '';
  } catch {
    return '';
  }
}
