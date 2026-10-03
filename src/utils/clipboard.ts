/**
 * Copy text to the clipboard, with a fallback.
 *
 * `navigator.clipboard.writeText` is not always available and not always allowed:
 * it needs a secure context, and a sandboxed preview iframe has no
 * `clipboard-write` permission, so the promise rejects there and the Copy button
 * appeared to do nothing at all. The old `execCommand('copy')` path still works
 * in those frames, so try the modern API first and fall back to it.
 *
 * @returns whether the text really reached the clipboard
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* refused or unavailable — fall through to the legacy path */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Keep it invisible but still selectable: `display: none` cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    area.select();
    const ok = document.execCommand('copy');

    area.remove();
    // Put the user's own selection back where it was.
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return Boolean(ok);
  } catch {
    return false;
  }
}
