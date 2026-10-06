import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_MODEL_ID, DEFAULT_LIMITS, headroom, limitsFor, nextDayResetAt, planAttempts, quotaDay,
  recordBusy, recordRequest, recordSuccess, resetQuotaState, routableModels, snapshot,
} from '../../server/agent/quota.js';

const { test } = globalThis.__agentTest;
console.log('\n[request quota]');

/** Each case gets its own ledger file; the day count is persisted on purpose. */
async function withDataDir(fn) {
  const previous = process.env.DANAV_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-quota-'));
  process.env.DANAV_DATA_DIR = root;
  resetQuotaState();
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DANAV_DATA_DIR;
    else process.env.DANAV_DATA_DIR = previous;
    resetQuotaState();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const provider = (over = {}) => ({
  id: 'provider-gemini',
  name: 'gemmni',
  quota: { enabled: true },
  models: [{ id: 'g-3.5' }, { id: 'g-3.6' }, { id: 'g-3.7' }, { id: 'g-3.8' }],
  ...over,
});
const MODELS = ['g-3.5', 'g-3.6', 'g-3.7', 'g-3.8'];

test('limits default to the documented free tier, and only real numbers override them', () => {
  // `confirmed` says whether these came from the provider or from a guess.
  const budget = (p, model) => { const { rpm, rpd } = limitsFor(p, model); return { rpm, rpd }; };
  assert.deepEqual(budget(provider(), 'g-3.5'), DEFAULT_LIMITS);
  assert.equal(limitsFor(provider(), 'g-3.5').confirmed, false, 'a default is an assumption and says so');
  const custom = provider({ quota: { enabled: true, limits: { 'g-3.5': { rpm: 10, rpd: 1000 }, '*': { rpm: 2, rpd: 50 } } } });
  assert.deepEqual(budget(custom, 'g-3.5'), { rpm: 10, rpd: 1000 });
  assert.deepEqual(budget(custom, 'g-3.9'), { rpm: 2, rpd: 50 }, 'unlisted models take the * entry');
  // Junk falls back to the documented tier rather than to "no limit".
  const junk = provider({ quota: { enabled: true, limits: { 'g-3.5': { rpm: 0, rpd: -4 } } } });
  assert.deepEqual(budget(junk, 'g-3.5'), DEFAULT_LIMITS);
});

test('the day resets at midnight Pacific, which is when the provider resets it', () => {
  // 07:30 UTC on the 7th is still the 6th in Los Angeles: the same quota day.
  assert.equal(quotaDay(Date.parse('2026-10-06T20:00:00Z')), '2026-10-06');
  assert.equal(quotaDay(Date.parse('2026-10-07T06:59:00Z')), '2026-10-06');
  assert.equal(quotaDay(Date.parse('2026-10-07T07:01:00Z')), '2026-10-07');
});

test('the planner spends every key on the asked-for model before changing model', async () => {
  await withDataDir(() => {
    const p = provider();
    const at = Date.parse('2026-10-06T10:00:00Z');
    // Three keys at the per-minute limit each, and then the model is full.
    const burst = 3 * DEFAULT_LIMITS.rpm;
    for (let i = 0; i < burst; i++) {
      const [best] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
      assert.equal(best.model, 'g-3.5', `request ${i + 1} should still fit on the asked-for model`);
      recordRequest(p.id, best.credentialIndex, best.model, at);
    }
    const [overflow] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
    assert.equal(overflow.model, 'g-3.6', 'only now does it fall back, and to the next model in order');
    assert.equal(overflow.available, true);

    // The window slides, so the original model comes back on its own.
    const [after] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at: at + 61_000 });
    assert.equal(after.model, 'g-3.5', 'a minute later the preferred model is free again');
  });
});

test('keys wear down evenly instead of one being emptied first', async () => {
  await withDataDir(() => {
    const p = provider();
    const at = Date.parse('2026-10-06T10:00:00Z');
    const picked = [];
    for (let i = 0; i < 6; i++) {
      const [best] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
      picked.push(best.credentialIndex);
      recordRequest(p.id, best.credentialIndex, best.model, at);
    }
    // Six requests over three keys is two each, not five-then-one.
    for (const key of [0, 1, 2]) {
      assert.equal(picked.filter((k) => k === key).length, 2, `key ${key} should have taken an even share`);
    }
  });
});

test('a refusal parks that exact pair, and a 429 is believed about the whole minute', async () => {
  await withDataDir(() => {
    const p = provider();
    const at = Date.parse('2026-10-06T10:00:00Z');

    // "This model is currently experiencing high demand" is about the model:
    // measured against the real provider, a second key gets the same answer in
    // the same instant while another model answers fine. So a 503 moves the
    // request to another MODEL, and the keys of the busy one are not spent
    // proving the point.
    recordBusy(p.id, 0, 'g-3.5', { status: 503, at });
    const [afterBusy] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
    assert.equal(afterBusy.model, 'g-3.6', 'a busy model is stepped over');
    assert.equal(afterBusy.available, true);
    // Stepped over, not written off: it is still usable if nothing else is.
    const stillThere = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at })
      .filter((item) => item.model === 'g-3.5' && item.available);
    assert.equal(stillThere.length, 2, 'the other keys of a busy model stay available');
    // And the rest is forgiven the moment it answers again.
    recordSuccess(p.id, 1, 'g-3.5', at + 100);
    const [recovered] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at: at + 100 });
    assert.equal(recovered.model, 'g-3.5', 'one good answer clears the model');

    // A 429 means the provider counted requests we did not, so the local window
    // is filled to match — otherwise the planner offers the same pair again.
    recordBusy(p.id, 1, 'g-3.5', { status: 429, at });
    const refused = headroom(p, 1, 'g-3.5', at);
    assert.equal(refused.minuteLeft, 0);
    assert.equal(refused.available, false);

    // Succeeding clears a cooldown: one blip must not sideline a good key.
    recordSuccess(p.id, 0, 'g-3.5', at + 200);
    assert.equal(headroom(p, 0, 'g-3.5', at + 200).available, true);
  });
});

test('the reset is the provider\'s midnight, found rather than assumed', () => {
  // March 8th 2026 is a DST change in Los Angeles: that day is 23 hours long,
  // which fixed arithmetic gets wrong by an hour.
  const dst = Date.parse('2026-03-08T12:00:00Z');
  assert.equal(quotaDay(nextDayResetAt(dst)), '2026-03-09');
  assert.equal(quotaDay(nextDayResetAt(dst) - 90_000), '2026-03-08', 'and not a minute earlier');
  const plain = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(quotaDay(nextDayResetAt(plain)), '2026-10-07');
});

test('an exhausted day is finished, not merely delayed', async () => {
  await withDataDir(() => {
    const p = provider();
    const at = Date.parse('2026-10-06T10:00:00Z');
    for (let i = 0; i < DEFAULT_LIMITS.rpd; i++) recordRequest(p.id, 0, 'g-3.5', at + i * 61_000);
    const spent = headroom(p, 0, 'g-3.5', at + (DEFAULT_LIMITS.rpd + 5) * 61_000);
    assert.equal(spent.dayLeft, 0);
    assert.equal(spent.available, false);
    // Infinity, not "in 60s" — waiting for the minute window would never help.
    assert.equal(spent.readyAt, Infinity);
  });
});

test('the ledger survives a restart, because the provider does not give the day back', async () => {
  await withDataDir(async () => {
    const p = provider();
    const now = Date.now();
    for (let i = 0; i < 4; i++) recordRequest(p.id, 0, 'g-3.5', now);
    // The write is debounced; the counts are what must survive, so wait for it.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    resetQuotaState(); // the restart
    assert.equal(headroom(p, 0, 'g-3.5', now).dayUsed, 4, 'today\'s count is read back');
    assert.equal(headroom(p, 0, 'g-3.5', now).minuteUsed, 0, 'the minute window is not, and need not be');
  });
});

test('the totals are every key and model added together, which is what the user has', async () => {
  await withDataDir(() => {
    const p = { ...provider(), apiKeyCount: 8 };
    const at = Date.parse('2026-10-06T10:00:00Z');
    recordRequest(p.id, 0, 'g-3.5', at);
    recordRequest(p.id, 3, 'g-3.7', at);
    const [view] = snapshot([p], at);
    assert.equal(view.credentialCount, 8);
    assert.equal(view.dayLimit, 8 * 4 * DEFAULT_LIMITS.rpd, 'every key on every model, added up');
    assert.equal(view.dayUsed, 2);
    assert.equal(view.minuteLimit, 8 * 4 * DEFAULT_LIMITS.rpm);
    const line = view.models.find((m) => m.model === 'g-3.5');
    assert.equal(line.dayUsed, 1);
    assert.equal(line.keysAvailable, 8, 'one spent request does not close a key');
    // A provider that has not opted in is not reported at all.
    assert.deepEqual(snapshot([{ ...p, quota: { enabled: false } }], at), []);
  });
});

test('the provider form turns the budget on and off without a text editor', async () => {
  const { buildEditedProvider } = await import('../../src/components/providerSettings.js');
  const { mergeSettingsPatch } = await import('../../server/settings.js');
  const saved = {
    id: 'provider-gemini', name: 'g', baseUrl: 'u', apiType: 'openai',
    apiKeyCount: 8, models: [{ id: 'a' }],
    quota: { enabled: true, limits: { '*': { rpm: 5, rpd: 20 } } },
  };
  const edit = (quota) => buildEditedProvider(saved, {
    name: 'g', baseUrl: 'u', apiType: 'openai', apiKeys: [], models: [{ id: 'a' }], quota,
  });

  // Typed into the form, so strings, and they must survive the trip to disk.
  const on = mergeSettingsPatch({ providers: [saved] }, { providers: [edit({ enabled: true, rpm: '7', rpd: ' 40 ' })] });
  assert.deepEqual(on.providers[0].quota, { enabled: true, limits: { '*': { rpm: 7, rpd: 40 } } });

  const off = mergeSettingsPatch({ providers: [saved] }, { providers: [edit({ enabled: false, rpm: '7', rpd: '40' })] });
  assert.equal(off.providers[0].quota.enabled, false, 'unticking the box really turns it off');
});

test('auto is a request to choose, never a model a provider is asked for', async () => {
  await withDataDir(() => {
    const p = provider();
    const at = Date.parse('2026-10-06T10:00:00Z');
    const plan = planAttempts(p, AUTO_MODEL_ID, { credentialCount: 2, models: MODELS, at });
    assert.ok(plan.length, 'it still plans');
    assert.equal(plan.every((item) => item.model !== AUTO_MODEL_ID), true, 'no attempt is addressed to "auto"');
    assert.equal(plan[0].model, 'g-3.5', 'with everything free it takes the first model listed');
    assert.deepEqual(routableModels({ models: [{ id: AUTO_MODEL_ID }, { id: 'g-3.5' }] }), ['g-3.5']);

    // Fill the first model on both keys: auto moves on without being told.
    for (let i = 0; i < 2 * DEFAULT_LIMITS.rpm; i++) recordRequest(p.id, i % 2, 'g-3.5', at);
    const [next] = planAttempts(p, AUTO_MODEL_ID, { credentialCount: 2, models: MODELS, at });
    assert.equal(next.model, 'g-3.6');
    assert.equal(next.available, true);
  });
});

test('the browser is offered auto, and can never save it as a model', async () => {
  const { mergeSettingsPatch, publicSettings } = await import('../../server/settings.js');
  const base = {
    providers: [{
      id: 'provider-gemini', name: 'gemmni', baseUrl: 'https://example.test/v1', apiType: 'openai',
      apiKeys: ['k1', 'k2'], quota: { enabled: true },
      models: [{ id: 'g-3.5' }, { id: 'g-3.6' }],
    }],
  };
  const [shown] = publicSettings(base).providers;
  assert.equal(shown.models[0].id, AUTO_MODEL_ID, 'the router is offered first');
  assert.match(shown.models[0].description, /2 models and 2 keys/);
  assert.deepEqual(shown.models.slice(1).map((m) => m.id), ['g-3.5', 'g-3.6']);

  // The browser hands back what it was shown; storing it would make "auto" a
  // model the planner could address.
  const saved = mergeSettingsPatch(base, { providers: [{ ...shown, models: shown.models }] });
  assert.deepEqual(saved.providers[0].models.map((m) => m.id), ['g-3.5', 'g-3.6']);

  // A provider that has not opted in is offered nothing extra.
  const plain = publicSettings({ providers: [{ ...base.providers[0], quota: { enabled: false } }] });
  assert.deepEqual(plain.providers[0].models.map((m) => m.id), ['g-3.5', 'g-3.6']);
});

test('the catalogue and the budget are read from disk, not from the request', async () => {
  const { resolveConfiguredProvider } = await import('../../server/settings.js');
  const settings = {
    providers: [{
      id: 'provider-gemini', baseUrl: 'https://example.test/v1', apiType: 'openai',
      apiKeys: ['k1'], quota: { enabled: true, limits: { '*': { rpm: 5, rpd: 20 } } },
      models: [{ id: 'g-3.5' }, { id: 'g-3.6' }],
    }],
  };
  // Agent mode sends an id and an endpoint and nothing else. Without the stored
  // catalogue the router has no model to fall back to and no limit to respect.
  const resolved = resolveConfiguredProvider(
    { id: 'provider-gemini', baseUrl: 'https://example.test/v1', apiType: 'openai' },
    settings,
  );
  assert.deepEqual(resolved.models.map((m) => m.id), ['g-3.5', 'g-3.6']);
  assert.equal(resolved.quota.enabled, true);
  assert.equal(resolved.apiKeys.length, 1);

  // A limit the caller invented is replaced by the saved one.
  const lying = resolveConfiguredProvider(
    { id: 'provider-gemini', baseUrl: 'https://example.test/v1', apiType: 'openai', quota: { enabled: true, limits: { '*': { rpm: 9999, rpd: 9999 } } } },
    settings,
  );
  assert.deepEqual(lying.quota.limits['*'], { rpm: 5, rpd: 20 });
});

/**
 * A provider that can be told how to answer each model.
 *
 * `plan[model]` is a status code, or 200 for a normal short SSE reply. Every
 * request is recorded with its key, model and arrival time, which is how the
 * tests below check that a busy model costs ONE request rather than one per key.
 */
async function fakeProvider(plan) {
  const http = await import('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const model = (() => { try { return JSON.parse(body).model; } catch { return ''; } })();
      seen.push({
        model,
        key: String(req.headers.authorization || '').replace('Bearer ', ''),
        at: Date.now(),
      });
      const status = typeof plan[model] === 'number' ? plan[model] : (plan['*'] ?? 200);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof plan.body === 'string' ? plan.body : JSON.stringify({ error: { code: status, message: 'busy' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

const budgeted = (baseUrl, over = {}) => ({
  id: 'provider-gemini',
  name: 'gemmni',
  baseUrl,
  apiType: 'openai',
  apiKeys: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'],
  quota: { enabled: true, limits: { '*': { rpm: 5, rpd: 20 } } },
  models: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }, { id: 'm-4' }],
  ...over,
});

test('a busy model costs one request, not one per key', async () => {
  // This is the failure the user hit: "this model is experiencing high demand"
  // is about the MODEL, so sweeping eight keys against it burns eight requests
  // and a minute of silence to learn what the first answer already said.
  await withDataDir(async () => {
    const up = await fakeProvider({ 'm-1': 503 });
    const { streamCompletion } = await import('../../server/agent/llm.js');
    const notes = [];
    const started = Date.now();
    try {
      await streamCompletion({
        provider: budgeted(up.baseUrl),
        model: AUTO_MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
        onText: () => {},
        onRetry: (info) => notes.push(info),
      });
    } finally {
      up.close();
    }
    const elapsed = Date.now() - started;
    assert.equal(up.seen.filter((r) => r.model === 'm-1').length, 1, 'the busy model is asked exactly once');
    assert.equal(up.seen.length, 2, 'one refusal, one answer');
    assert.equal(up.seen[1].model, 'm-2', 'and the next model is tried straight away');
    assert.ok(elapsed < 2_000, `took ${elapsed}ms; a busy model must not be slept on`);
    assert.ok(
      notes.some((n) => /m-1 is busy; switching to m-2/.test(n.reason)),
      `the user is told what happened: ${notes.map((n) => n.reason).join(' | ')}`,
    );
    assert.ok(notes.every((n) => n.delayMs === 0), 'and nothing waits while a free model exists');
  });
});

test('an estimated budget is never a reason to refuse to work', async () => {
  // The configured limit is a guess. If it is too low, obeying it would leave
  // eight working keys idle, which is worse than being told no by the provider.
  await withDataDir(async () => {
    const up = await fakeProvider({});
    const { streamCompletion } = await import('../../server/agent/llm.js');
    const provider = budgeted(up.baseUrl, {
      apiKeys: ['k1'],
      models: [{ id: 'm-1' }],
      quota: { enabled: true, limits: { '*': { rpm: 1, rpd: 1 } } },
    });
    try {
      for (let i = 0; i < 3; i++) {
        await streamCompletion({
          provider, model: 'm-1', messages: [{ role: 'user', content: 'hi' }], onText: () => {},
        });
      }
    } finally {
      up.close();
    }
    assert.equal(up.seen.length, 3, 'all three were sent, despite a budget of one');
  });
});

test('a refusal is believed, and the limit it states is learned', async () => {
  await withDataDir(async () => {
    const quotaFailure = JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' },
            { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '250' },
          ],
        }],
      },
    });
    const up = await fakeProvider({ '*': 429, body: quotaFailure });
    const { streamCompletion } = await import('../../server/agent/llm.js');
    const provider = budgeted(up.baseUrl, { apiKeys: ['k1'], models: [{ id: 'm-1' }] });
    const started = Date.now();
    try {
      await assert.rejects(() => streamCompletion({
        provider, model: 'm-1', messages: [{ role: 'user', content: 'hi' }], onText: () => {},
      }));
    } finally {
      up.close();
    }
    // The provider's own numbers replace the configured guess.
    assert.deepEqual(limitsFor(provider, 'm-1'), { rpm: 10, rpd: 250, confirmed: true });
    assert.equal(headroom(provider, 0, 'm-1').refused, true, 'and the pair is known to be genuinely refused');
    // One key, one model, confirmed empty: that is reported, not slept through.
    assert.ok(Date.now() - started < 20_000, 'it gives up in seconds, not minutes');
  });
});
