/** Settings boundary and key-edit regressions: secrets stay server-side and edits are intentional. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildEditedProvider } from '../../src/components/providerSettings.js';
import { mergeSettingsPatch, publicSettings, resolveConfiguredProvider } from '../../server/settings.js';

const { test } = globalThis.__agentTest;

console.log('\n[settings security]');

test('public settings never return provider credentials or unapproved provider fields', () => {
  const secret = 'test-provider-key-never-return-this';
  const safe = publicSettings({
    theme: 'dark',
    lastSelectedProviderId: 'p1',
    lastSelectedModelId: 'm1',
    privateNote: 'not part of the public settings contract',
    providers: [{
      id: 'p1', name: 'Example', baseUrl: 'https://example.test/v1', apiType: 'openai',
      apiKey: secret, internalToken: 'also-private', enabled: true,
      models: [{ id: 'm1', name: 'Model', providerId: 'p1', supportsThinking: true, private: 'nope' }],
    }],
  });
  assert.equal(safe.providers[0].apiKey, undefined);
  assert.equal(safe.providers[0].apiKeyConfigured, true);
  assert.equal(safe.providers[0].internalToken, undefined);
  assert.equal(safe.providers[0].models[0].private, undefined);
  assert.equal(safe.privateNote, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /test-provider-key-never-return-this|also-private/);
});

test('provider edits preserve a saved key when blank, replace only when entered, and clear explicitly', () => {
  const provider = {
    id: 'p1', name: 'Before', baseUrl: 'https://example.test/v1', apiType: 'openai',
    apiKeyConfigured: true, models: [],
  };
  const fields = { name: 'After', baseUrl: provider.baseUrl, apiType: 'openai', models: [], apiKey: '' };

  const unchanged = buildEditedProvider(provider, fields);
  assert.equal(unchanged.apiKey, undefined, 'blank edit must not send a blank replacement');
  assert.equal(unchanged.apiKeyConfigured, true);
  assert.equal(unchanged.clearApiKey, undefined);

  const replaced = buildEditedProvider(provider, { ...fields, apiKey: '  replacement-key  ' });
  assert.equal(replaced.apiKey, 'replacement-key');
  assert.equal(replaced.apiKeyConfigured, true);
  assert.equal(replaced.clearApiKey, undefined);

  const cleared = buildEditedProvider(provider, { ...fields, clearSavedApiKey: true });
  assert.equal(cleared.apiKey, '');
  assert.equal(cleared.apiKeyConfigured, false);
  assert.equal(cleared.clearApiKey, true);
});

test('settings updates retain omitted keys, replace entered keys, and honor explicit removal', () => {
  const current = { theme: 'light', providers: [{ id: 'p1', apiKey: 'stored-key', name: 'Before' }] };
  const kept = mergeSettingsPatch(current, { providers: [{ id: 'p1', name: 'Edited', apiKeyConfigured: true }] });
  assert.equal(kept.providers[0].apiKey, 'stored-key');
  assert.equal(kept.providers[0].name, 'Edited');
  assert.equal(kept.providers[0].apiKeyConfigured, undefined);

  const replaced = mergeSettingsPatch(kept, { providers: [{ id: 'p1', apiKey: '  new-key  ' }] });
  assert.equal(replaced.providers[0].apiKey, 'new-key');

  const cleared = mergeSettingsPatch(replaced, { providers: [{ id: 'p1', apiKey: '', clearApiKey: true }] });
  assert.equal(cleared.providers[0].apiKey, '');
  assert.equal(cleared.providers[0].clearApiKey, undefined);
});

test('stored provider credentials are never reused for a different endpoint', () => {
  const settings = { providers: [{ id: 'p1', baseUrl: 'https://trusted.test/v1/', apiType: 'openai', apiKey: 'stored-key' }] };
  const resolved = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://trusted.test/v1', apiType: 'openai' }, settings);
  assert.equal(resolved.apiKey, 'stored-key');
  assert.equal(resolved.baseUrl, 'https://trusted.test/v1/');

  const mismatch = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://attacker.test/v1', apiType: 'openai' }, settings);
  assert.equal(mismatch.apiKey, '');
  assert.equal(mismatch.baseUrl, 'https://attacker.test/v1');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('settings HTTP routes redact keys, preserve blank edits, and resolve credentials server-side', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-settings-http-'));
  const requests = [];
  const providerServer = http.createServer((req, res) => {
    requests.push(req.headers.authorization || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[]}');
  });
  const providerPort = await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', () => resolve(providerServer.address().port));
  });
  const baseUrl = `http://127.0.0.1:${providerPort}/v1`;
  const backendPort = await reservePort();
  const previewToken = 'settings-route-preview-token-for-tests';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DANAV_DATA_DIR: dataDir,
      PORT: String(backendPort),
      DANAV_PREVIEW_TOKEN: previewToken,
      GEMINI_API_KEY: 'settings-route-test-env-secret',
      VYCE_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const onOutput = (chunk) => { logs += chunk.toString(); };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend did not start: ${logs}`)), 12_000);
    const check = (chunk) => {
      logs += chunk.toString();
      if (logs.includes(`Backend server running on http://localhost:${backendPort}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited before ready (${code}): ${logs}`));
    });
  });

  const url = `http://127.0.0.1:${backendPort}`;
  const postJson = (route, body, origin) => fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-danav-preview-token': previewToken, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const testSavedProvider = async () => {
    const response = await postJson('/api/providers/test', { id: 'p-http', baseUrl, apiType: 'openai' }, 'https://untrusted.example');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'credential-backed provider routes are same-origin only');
    assert.equal((await response.json()).success, true);
  };

  try {
    await ready;
    const noToken = await fetch(`${url}/api/settings`);
    assert.equal(noToken.status, 401, 'the preview backend rejects API requests without the access code');
    const badCheck = await fetch(`${url}/api/preview-auth/check`, { headers: { 'x-danav-preview-token': 'incorrect' } });
    assert.equal(badCheck.status, 401, 'the access-code check rejects an incorrect token');
    const goodCheck = await fetch(`${url}/api/preview-auth/check`, { headers: { 'x-danav-preview-token': previewToken } });
    assert.equal(goodCheck.status, 200);
    assert.deepEqual(await goodCheck.json(), { required: true, authenticated: true });
    const authHeaders = { 'x-danav-preview-token': previewToken, Origin: 'https://untrusted.example' };
    const initial = await fetch(`${url}/api/settings`, { headers: authHeaders });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('access-control-allow-origin'), null, 'settings do not grant cross-origin reads');
    const trailingSlash = await fetch(`${url}/api/settings/`, { headers: authHeaders });
    assert.equal(trailingSlash.headers.get('access-control-allow-origin'), null, 'a trailing slash cannot bypass the settings CORS guard');
    const upperCasePath = await fetch(`${url}/API/SETTINGS`, { headers: authHeaders });
    assert.equal(upperCasePath.headers.get('access-control-allow-origin'), null, 'case-insensitive Express routes remain protected');
    const initialText = await initial.text();
    assert.doesNotMatch(initialText, /settings-route-test-env-secret/);

    const savedSecret = 'settings-route-test-provider-secret';
    const firstSave = await postJson('/api/settings', { providers: [{
      id: 'p-http', name: 'HTTP fixture', baseUrl, apiType: 'openai', apiKey: savedSecret, models: [],
    }] });
    assert.equal(firstSave.status, 200);
    const firstSaveText = await firstSave.text();
    assert.doesNotMatch(firstSaveText, /settings-route-test-provider-secret/);
    assert.match(firstSaveText, /"apiKeyConfigured":true/);

    // Editing other provider fields with the key field blank must not erase it.
    const blankEdit = await postJson('/api/settings', { providers: [{
      id: 'p-http', name: 'Renamed fixture', baseUrl, apiType: 'openai', apiKeyConfigured: true, models: [],
    }] });
    assert.equal(blankEdit.status, 200);
    assert.doesNotMatch(await blankEdit.text(), /settings-route-test-provider-secret/);
    await testSavedProvider();
    assert.equal(requests.at(-1), `Bearer ${savedSecret}`);

    // A newly typed key replaces the old one; explicit clear removes it.
    const replacementSecret = 'settings-route-test-replacement-secret';
    const replacement = await postJson('/api/settings', { providers: [{
      id: 'p-http', name: 'Renamed fixture', baseUrl, apiType: 'openai', apiKey: replacementSecret, models: [],
    }] });
    assert.equal(replacement.status, 200);
    assert.doesNotMatch(await replacement.text(), /settings-route-test-replacement-secret/);
    await testSavedProvider();
    assert.equal(requests.at(-1), `Bearer ${replacementSecret}`);

    const clear = await postJson('/api/settings', { providers: [{
      id: 'p-http', name: 'Renamed fixture', baseUrl, apiType: 'openai', apiKey: '', clearApiKey: true, models: [],
    }] });
    assert.equal(clear.status, 200);
    assert.doesNotMatch(await clear.text(), /settings-route-test-replacement-secret/);
    await testSavedProvider();
    assert.equal(requests.at(-1), '', 'a cleared key is not sent to the configured provider');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1500)]);
    await new Promise((resolve) => providerServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
