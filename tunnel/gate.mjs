// gate.mjs — tiny password gate (HTTP Basic Auth) + streaming reverse proxy.
//
// Why: Danav AI Chat has no login of its own, and GET /api/settings returns the
// saved provider API keys. Putting a public tunnel straight on the app would hand
// those to anyone who finds the URL. This sits between the tunnel and the app.
// Nothing in the repo is modified.
//
//   GATE_USER       username                       (default: danav)
//   GATE_PASS       password   -- or --  GATE_PASS_FILE=/path/to/file
//   TARGET_PORT     port of the app/backend        (default: 3001)
//   GATE_PORT       port the gate listens on       (default: 8081, loopback only)
//
// Refuses to start without a password.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const USER = process.env.GATE_USER || 'danav';
const PASS =
  process.env.GATE_PASS ||
  (process.env.GATE_PASS_FILE ? fs.readFileSync(process.env.GATE_PASS_FILE, 'utf8').trim() : '');
const TARGET_PORT = Number(process.env.TARGET_PORT || 3001);
const GATE_PORT = Number(process.env.GATE_PORT || 8081);

if (!PASS) {
  console.error('[gate] No password set (GATE_PASS / GATE_PASS_FILE). Refusing to start unprotected.');
  process.exit(1);
}

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const expected = digest(`${USER}:${PASS}`);

function isAuthorized(header) {
  if (!header || !/^Basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  return crypto.timingSafeEqual(digest(decoded), expected); // constant-time compare
}

// No keep-alive towards the app: avoids "socket hang up" races with Node's 5s idle timeout.
const upstream = new http.Agent({ keepAlive: false });

const server = http.createServer((req, res) => {
  if (!isAuthorized(req.headers.authorization)) {
    req.resume();
    // Small delay makes online password guessing painfully slow.
    setTimeout(() => {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Danav AI Chat", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Login required.\n');
    }, 400);
    return;
  }

  const headers = { ...req.headers };
  delete headers.authorization; // don't forward the gate password to the app

  const proxyReq = http.request(
    { host: '127.0.0.1', port: TARGET_PORT, method: req.method, path: req.url, headers, agent: upstream },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res); // piped, not buffered -> chat streaming (SSE) stays progressive
    }
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`App not reachable: ${err.message}\n`);
  });
  res.on('close', () => proxyReq.destroy()); // visitor left / pressed Stop -> stop upstream too
  req.pipe(proxyReq);
});

// Longer than Cloudflare's idle connection reuse window.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(GATE_PORT, '127.0.0.1', () =>
  console.log(`[gate] listening on 127.0.0.1:${GATE_PORT} -> app on 127.0.0.1:${TARGET_PORT} (user "${USER}")`)
);
