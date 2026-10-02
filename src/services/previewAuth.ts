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
