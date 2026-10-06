import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LIMITS, headroom, limitsFor, planAttempts, quotaDay,
  recordBusy, recordRequest, recordSuccess, resetQuotaState, snapshot,
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
