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
  assert.deepEqual(limitsFor(provider(), 'g-3.5'), DEFAULT_LIMITS);
  const custom = provider({ quota: { enabled: true, limits: { 'g-3.5': { rpm: 10, rpd: 1000 }, '*': { rpm: 2, rpd: 50 } } } });
  assert.deepEqual(limitsFor(custom, 'g-3.5'), { rpm: 10, rpd: 1000 });
  assert.deepEqual(limitsFor(custom, 'g-3.9'), { rpm: 2, rpd: 50 }, 'unlisted models take the * entry');
  // Guessing high is what produces the 429 this exists to avoid, so junk falls
  // back to the documented tier rather than to "no limit".
  const junk = provider({ quota: { enabled: true, limits: { 'g-3.5': { rpm: 0, rpd: -4 } } } });
  assert.deepEqual(limitsFor(junk, 'g-3.5'), DEFAULT_LIMITS);
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
    // 3 keys x 5 rpm = 15 requests before g-3.5 has nothing left this minute.
    for (let i = 0; i < 15; i++) {
      const [best] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
      assert.equal(best.model, 'g-3.5', `request ${i + 1} should still fit on the asked-for model`);
      recordRequest(p.id, best.credentialIndex, best.model, at);
    }
    const [sixteenth] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
    assert.equal(sixteenth.model, 'g-3.6', 'only now does it fall back, and to the next model in order');
    assert.equal(sixteenth.available, true);

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

    // 503 is the provider being busy, not this pair being over budget: a short
    // rest, and the very next choice must be a different key.
    recordBusy(p.id, 0, 'g-3.5', { status: 503, at });
    const [afterBusy] = planAttempts(p, 'g-3.5', { credentialCount: 3, models: MODELS, at });
    assert.equal(afterBusy.model, 'g-3.5', 'a busy key is not a reason to change model');
    assert.notEqual(afterBusy.credentialIndex, 0, 'but it is a reason to change key');

    // A 429 means the provider counted requests we did not, so the local window
    // is filled to match — otherwise the planner offers the same pair again.
    recordBusy(p.id, 1, 'g-3.5', { status: 429, at });
    const refused = headroom(p, 1, 'g-3.5', at);
    assert.equal(refused.minuteLeft, 0);
    assert.equal(refused.available, false);

    // Succeeding clears a cooldown: one blip must not sideline a good key.
    recordSuccess(p.id, 0, 'g-3.5', at);
    assert.equal(headroom(p, 0, 'g-3.5', at).available, true);
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
    for (let i = 0; i < 20; i++) recordRequest(p.id, 0, 'g-3.5', at + i * 61_000);
    const spent = headroom(p, 0, 'g-3.5', at + 25 * 61_000);
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
    assert.equal(view.dayLimit, 8 * 4 * DEFAULT_LIMITS.rpd, '8 keys x 4 models x 20 a day');
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
    for (let i = 0; i < 10; i++) recordRequest(p.id, i % 2, 'g-3.5', at);
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
