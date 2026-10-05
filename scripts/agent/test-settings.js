/** Settings boundary and key-edit regressions: secrets stay server-side and edits are intentional. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildEditedProvider } from '../../src/components/providerSettings.js';
import { mergeSettingsPatch, normalizeAgentSummaryModel, publicSettings, resolveAgentSummaryModel, resolveConfiguredProvider } from '../../server/settings.js';

const { test } = globalThis.__agentTest;

console.log('\n[settings security]');

test('public settings never return provider credentials or unapproved provider fields', () => {
  const secret = 'test-provider-key-never-return-this';
  const safe = publicSettings({
    theme: 'dark',
    lastSelectedProviderId: 'p1',
    lastSelectedModelId: 'm1',
    agentSummaryModel: { providerId: 'p1', modelId: 'm1', apiKey: 'must-not-be-returned' },
    privateNote: 'not part of the public settings contract',
    providers: [{
      id: 'p1', name: 'Example', baseUrl: 'https://example.test/v1', apiType: 'openai',
      apiKey: secret, internalToken: 'also-private', enabled: true,
      models: [{ id: 'm1', name: 'Model', providerId: 'p1', supportsThinking: true, private: 'nope' }],
    }],
  });
  assert.equal(safe.providers[0].apiKey, undefined);
  assert.equal(safe.providers[0].apiKeyConfigured, true);
  assert.equal(safe.providers[0].apiKeyCount, 1);
  assert.equal(safe.providers[0].internalToken, undefined);
  assert.equal(safe.providers[0].models[0].private, undefined);
  assert.deepEqual(safe.agentSummaryModel, { providerId: 'p1', modelId: 'm1' });
  assert.equal(safe.privateNote, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /test-provider-key-never-return-this|also-private/);
});

test('provider edits append any number of new keys while preserving saved keys unless explicitly cleared', () => {
  const provider = {
    id: 'p1', name: 'Before', baseUrl: 'https://example.test/v1', apiType: 'openai',
    apiKeyConfigured: true, apiKeyCount: 2, models: [],
  };
  const fields = { name: 'After', baseUrl: provider.baseUrl, apiType: 'openai', models: [], apiKeys: [] };

  const unchanged = buildEditedProvider(provider, fields);
  assert.equal(unchanged.apiKeyAdditions, undefined, 'blank rows add no keys');
  assert.equal(unchanged.apiKeys, undefined, 'actual credentials are not copied into provider state');
  assert.equal(unchanged.apiKeyCount, 2);
  assert.equal(unchanged.clearApiKeys, undefined);

  const appended = buildEditedProvider(provider, { ...fields, apiKeys: [' first-new-key ', 'second-new-key', 'first-new-key'] });
  assert.deepEqual(appended.apiKeyAdditions, ['first-new-key', 'second-new-key'], 'new keys are trimmed and deduplicated');
  assert.equal(appended.apiKeyCount, 4, 'the safe count includes saved and newly entered keys');
  assert.equal(appended.apiKey, undefined);

  const cleared = buildEditedProvider(provider, { ...fields, apiKeys: ['replacement-key'], clearSavedApiKeys: true });
  assert.deepEqual(cleared.apiKeyAdditions, ['replacement-key']);
  assert.equal(cleared.apiKeyCount, 1);
  assert.equal(cleared.clearApiKeys, true);
});

test('settings updates preserve, append, and explicitly clear multiple keys while retaining legacy single-key support', () => {
  const current = { theme: 'light', providers: [{ id: 'p1', apiKeys: ['stored-one', 'stored-two'], name: 'Before' }] };
  const kept = mergeSettingsPatch(current, { providers: [{ id: 'p1', name: 'Edited', apiKeyConfigured: true }] });
  assert.deepEqual(kept.providers[0].apiKeys, ['stored-one', 'stored-two']);
  const keyFreeArrayEdit = mergeSettingsPatch(current, { providers: [{ id: 'p1', apiKeys: [] }] });
  assert.deepEqual(keyFreeArrayEdit.providers[0].apiKeys, ['stored-one', 'stored-two'], 'an empty key-free array is not an implicit clear');
  assert.equal(kept.providers[0].name, 'Edited');
  assert.equal(kept.providers[0].apiKeyConfigured, undefined);

  const appended = mergeSettingsPatch(kept, { providers: [{ id: 'p1', apiKeyAdditions: [' stored-three ', 'stored-one'] }] });
  assert.deepEqual(appended.providers[0].apiKeys, ['stored-one', 'stored-two', 'stored-three']);
  assert.equal(appended.providers[0].apiKey, undefined);

  const replaced = mergeSettingsPatch(appended, { providers: [{ id: 'p1', apiKey: '  legacy-replacement  ' }] });
  assert.deepEqual(replaced.providers[0].apiKeys, ['legacy-replacement'], 'old clients can still replace the single key');

  const cleared = mergeSettingsPatch(replaced, { providers: [{ id: 'p1', clearApiKeys: true, apiKeyAdditions: ['after-clear'] }] });
  assert.deepEqual(cleared.providers[0].apiKeys, ['after-clear'], 'clear followed by additions leaves only the newly entered keys');
  assert.equal(cleared.providers[0].clearApiKeys, undefined);

  const legacyClear = mergeSettingsPatch(replaced, { providers: [{ id: 'p1', apiKey: '', clearApiKey: true }] });
  assert.deepEqual(legacyClear.providers[0].apiKeys, []);
  const explicitClearWins = mergeSettingsPatch(replaced, { providers: [{ id: 'p1', apiKey: 'stale-value', clearApiKeys: true }] });
  assert.deepEqual(explicitClearWins.providers[0].apiKeys, [], 'an explicit clear cannot be undone by a stale single-key value');
});

test('the background summary model is independent, validates against enabled providers, and resolves only server-side keys', () => {
  const settings = {
    agentSummaryModel: null,
    providers: [
      {
        id: 'p-summary', name: 'Summary provider', baseUrl: 'https://summary.test/v1', apiType: 'openai',
        apiKeys: ['private-summary-key'], models: [{ id: 'compact-1', name: 'Compact model', providerId: 'p-summary' }],
      },
      { id: 'p-disabled', baseUrl: 'https://disabled.test/v1', enabled: false, models: [{ id: 'off-model' }] },
      { id: 'p-mock', baseUrl: 'https://mock.test/v1', apiType: 'mock', models: [{ id: 'demo-model' }] },
    ],
  };
  const selection = { providerId: 'p-summary', modelId: 'compact-1' };
  assert.deepEqual(normalizeAgentSummaryModel(selection, settings.providers), selection);
  assert.equal(normalizeAgentSummaryModel({ providerId: 'p-disabled', modelId: 'off-model' }, settings.providers), null);
  assert.equal(normalizeAgentSummaryModel({ providerId: 'p-mock', modelId: 'demo-model' }, settings.providers), null);
  assert.equal(normalizeAgentSummaryModel({ providerId: 'p-summary', modelId: 'missing' }, settings.providers), null);

  const saved = mergeSettingsPatch(settings, { agentSummaryModel: selection });
  assert.deepEqual(saved.agentSummaryModel, selection);
  assert.deepEqual(mergeSettingsPatch(saved, { theme: 'dark' }).agentSummaryModel, selection, 'unrelated settings edits preserve the choice');
  assert.equal(mergeSettingsPatch(saved, { providers: [{ id: 'p-summary', baseUrl: 'https://summary.test/v1', models: [] }] }).agentSummaryModel, null, 'removing the selected model clears stale configuration');
  assert.deepEqual(publicSettings(saved).agentSummaryModel, selection);
  assert.doesNotMatch(JSON.stringify(publicSettings(saved)), /private-summary-key/);

  const fallback = { id: 'main-provider', baseUrl: 'https://main.test/v1', apiKeys: ['main-secret'] };
  const resolved = resolveAgentSummaryModel(saved, fallback, 'main-model');
  assert.equal(resolved.model, 'compact-1');
  assert.deepEqual(resolved.provider.apiKeys, ['private-summary-key']);
  assert.equal(resolved.provider.apiKey, 'private-summary-key');
  const sameAsTask = resolveAgentSummaryModel({ providers: settings.providers }, fallback, 'main-model');
  assert.equal(sameAsTask.provider, fallback);
  assert.equal(sameAsTask.model, 'main-model');
});

test('stored provider key lists stay with their endpoint and one-shot additions are merged safely', () => {
  const settings = { providers: [{ id: 'p1', baseUrl: 'https://trusted.test/v1/', apiType: 'openai', apiKeys: ['stored-one', 'stored-two'] }] };
  const resolved = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://trusted.test/v1', apiType: 'openai' }, settings);
  assert.deepEqual(resolved.apiKeys, ['stored-one', 'stored-two']);
  assert.equal(resolved.apiKey, 'stored-one');
  assert.equal(resolved.baseUrl, 'https://trusted.test/v1/');

  const testKeys = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://trusted.test/v1', apiType: 'openai', apiKeys: ['new-one'] }, settings);
  assert.deepEqual(testKeys.apiKeys, ['stored-one', 'stored-two', 'new-one'], 'connection checks can fall back from saved to newly typed keys');

  const replaced = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://trusted.test/v1', apiType: 'openai', apiKeys: ['new-one'], clearApiKeys: true }, settings);
  assert.deepEqual(replaced.apiKeys, ['new-one'], 'explicit clearing excludes the saved list');
  const clearBeatsLegacyValue = resolveConfiguredProvider({
    id: 'p1', baseUrl: 'https://trusted.test/v1', apiType: 'openai', apiKey: 'stale-legacy-key', clearApiKeys: true,
  }, settings);
  assert.deepEqual(clearBeatsLegacyValue.apiKeys, [], 'an explicit clear ignores a stray legacy key');
  assert.equal(clearBeatsLegacyValue.apiKey, '');
  const clearWithoutStoredProvider = resolveConfiguredProvider({
    baseUrl: 'https://unconfigured.test/v1', apiType: 'openai', apiKey: 'stale-legacy-key', clearApiKeys: true,
  }, settings);
  assert.deepEqual(clearWithoutStoredProvider.apiKeys, []);
  assert.equal(clearWithoutStoredProvider.apiKey, '');

  const mismatch = resolveConfiguredProvider({ id: 'p1', baseUrl: 'https://attacker.test/v1', apiType: 'openai' }, settings);
  assert.deepEqual(mismatch.apiKeys, []);
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
  const rejectedProviderKeys = new Set();
  const providerServer = http.createServer((req, res) => {
    const authorization = req.headers.authorization || '';
    requests.push(authorization);
    if (rejectedProviderKeys.has(authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"invalid test key"}}');
    }
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

    const firstKey = 'settings-route-first-multi-key';
    const secondKey = 'settings-route-second-multi-key';
    const multiSave = await postJson('/api/settings', { providers: [{
      id: 'p-rotation', name: 'Rotation fixture', baseUrl, apiType: 'openai',
      apiKeyAdditions: [firstKey, secondKey], models: [{ id: 'compact-summary', name: 'Compact summary', providerId: 'p-rotation' }],
    }] });
    assert.equal(multiSave.status, 200);
    const multiSaveText = await multiSave.text();
    assert.match(multiSaveText, /"apiKeyCount":2/);
    assert.doesNotMatch(multiSaveText, /settings-route-(?:first|second)-multi-key/);

    rejectedProviderKeys.add(`Bearer ${firstKey}`);
    const beforeRotation = requests.length;
    const rotated = await postJson('/api/providers/test', {
      id: 'p-rotation', baseUrl, apiType: 'openai',
    }, 'https://untrusted.example');
    assert.equal(rotated.status, 200, 'the second configured key is tried after the first is rejected');
    assert.deepEqual(requests.slice(beforeRotation), [`Bearer ${firstKey}`, `Bearer ${secondKey}`]);

    const selectedModel = await postJson('/api/settings', { agentSummaryModel: { providerId: 'p-rotation', modelId: 'compact-summary' } });
    assert.equal(selectedModel.status, 200);
    const selectedBody = await selectedModel.json();
    assert.deepEqual(selectedBody.settings.agentSummaryModel, { providerId: 'p-rotation', modelId: 'compact-summary' });
    assert.doesNotMatch(JSON.stringify(selectedBody), /settings-route-(?:first|second)-multi-key/);

    const removedProvider = await postJson('/api/settings', { providers: [{
      id: 'p-http', name: 'HTTP fixture', baseUrl, apiType: 'openai', models: [],
    }] });
    assert.equal(removedProvider.status, 200);
    assert.equal((await removedProvider.json()).settings.agentSummaryModel, null, 'removing the selected provider clears the stale summary-model choice');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1500)]);
    await new Promise((resolve) => providerServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
