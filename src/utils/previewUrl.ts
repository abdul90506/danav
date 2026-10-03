/**
 * Is this link the app the agent just built?
 *
 * The model usually surfaces the preview through the `get_preview_url` tool, and
 * that path already gets a "Preview" button. But it very often ALSO just prints
 * the URL as text — and a plain link is a dead end: clicking it throws the user
 * into a browser tab when the whole point of the docked panel is to keep the
 * chat next to the running app.
 *
 * So links are recognised by their HOST. A Novita sandbox host, a tunnel, or a
 * localhost port is never a news article — it is a server the agent started.
 */

/** Hosts that only ever serve something built in a workspace. */
const PREVIEW_HOSTS = [
  /\.sandbox\.novita\.ai$/i, // the Novita Agent Sandbox preview domain
  /\.novita\.ai$/i,
  /\.trycloudflare\.com$/i, // `cloudflared tunnel`
  /\.loca\.lt$/i,
  /\.ngrok-free\.app$/i,
  /\.ngrok\.io$/i,
  /\.serveo\.net$/i,
  /\.githubpreview\.dev$/i, // Codespaces port forwarding
  /\.gitpod\.io$/i,
];

const LOOPBACK_HOSTS = [/^localhost$/i, /^127\.0\.0\.1$/i, /^0\.0\.0\.0$/i, /^\[::1\]$/i];

/**
 * @param href the link target
 * @param opts.allowLoopback also treat localhost/127.0.0.1 as a preview. Only
 *   true inside an agent conversation, where a local port is a dev server.
 */
export function isPreviewUrl(href?: string, opts: { allowLoopback?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(String(href || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (PREVIEW_HOSTS.some((re) => re.test(url.hostname))) return true;
  return Boolean(opts.allowLoopback) && LOOPBACK_HOSTS.some((re) => re.test(url.hostname));
}

/** The host, for a compact label. Falls back to the raw string. */
export function previewHost(href?: string): string {
  try {
    return new URL(String(href || '')).host;
  } catch {
    return String(href || '');
  }
}
