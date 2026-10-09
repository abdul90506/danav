import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Last-resort page fetch using the system `curl`.
 *
 * Cloudflare and similar bot walls fingerprint the TLS handshake. Node's client
 * gets a flat 403 "Just a moment..." for a URL that loads perfectly in curl —
 * the same request, a different TLS stack. Shelling out to curl is a pragmatic
 * fallback that actually retrieves the page, and curl ships with Windows 10+,
 * macOS and virtually every Linux image.
 *
 * Resolves to `{ status, text, effectiveUrl }` or `null` when curl is
 * unavailable / fails. `effectiveUrl` is where the request ended up after
 * redirects: curl follows them (`-L`) invisibly, so the caller needs it to
 * confirm the body really came from a public address.
 */
export function fetchViaCurl(targetUrl, { timeoutMs = 20000, userAgent = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const tmpFile = path.join(
      os.tmpdir(),
      `blackdesi-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    const cleanup = () => {
      try {
        fs.unlinkSync(tmpFile);
      } catch (e) {
        /* already gone */
      }
    };

    const args = [
      '-sL', // silent, follow redirects
      '--compressed',
      '--max-time',
      String(Math.max(5, Math.round(timeoutMs / 1000))),
      '-o',
      tmpFile,
      '-w',
      '%{http_code} %{url_effective}',
      '-H',
      'Accept: text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
    ];
    if (userAgent) args.push('-A', userAgent);
    args.push(targetUrl);

    let child;
    try {
      child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
        windowsHide: true,
      });
    } catch (e) {
      cleanup();
      return finish(null);
    }

    let statusText = '';
    child.stdout?.on('data', (chunk) => {
      statusText += chunk.toString();
    });

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {
        /* already dead */
      }
      cleanup();
      finish(null);
    }, timeoutMs + 3000);

    child.on('error', () => {
      clearTimeout(killTimer);
      cleanup();
      finish(null);
    });

    child.on('close', () => {
      clearTimeout(killTimer);
      let text = '';
      try {
        text = fs.readFileSync(tmpFile, 'utf-8');
      } catch (e) {
        text = '';
      }
      cleanup();

      // `-w` prints "<code> <final url>"; split on the first space so a URL with
      // spaces in it survives.
      const written = statusText.trim();
      const firstSpace = written.indexOf(' ');
      const codeText = firstSpace === -1 ? written : written.slice(0, firstSpace);
      const effectiveUrl = firstSpace === -1 ? '' : written.slice(firstSpace + 1).trim();
      const status = parseInt(codeText, 10);
      if (!text || text.length < 200) return finish(null);
      finish({
        status: Number.isFinite(status) ? status : 0,
        text,
        effectiveUrl: effectiveUrl || targetUrl,
      });
    });
  });
}
