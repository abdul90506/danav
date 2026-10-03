/**
 * Sandbox lifecycle: the auto-pause decision, the account-wide listing, and the
 * routes that let the user pause / resume / delete a sandbox by hand.
 *
 * No network and no API key here — the SDK calls are injected or absent, which is
 * exactly what makes the DECISION testable without spending money on real VMs.
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { normalizeSandbox } from '../../server/agent/sandboxAdmin.js';
import { sweepIdleSandboxes } from '../../server/agent/idlePause.js';
import {
  _reset as resetActivity, forget, markPaused, markRunning, msUntilPause, noteRunFinished,
  reasonToPause, stateOf, touch,
} from '../../server/agent/sandboxActivity.js';
import { addWorkspaceRecord, _resetStoreCache } from '../../server/agent/store.js';
import { registerAgentRoutes } from '../../server/agent/routes.js';

const { test } = globalThis.__agentTest;

console.log('\n[sandbox lifecycle]');

// ---------------------------------------------------------------------------
// The clock: idle vs "the run just finished"
// ---------------------------------------------------------------------------
// `limits` reads the environment on every call, so these tests can drive time
// by setting the windows and passing an explicit `now`.

/** Run `fn` with the two windows set, then put the environment back. */
function withWindows(idleSeconds, graceSeconds, fn) {
  const prev = {
    idle: process.env.DANAV_SANDBOX_IDLE_PAUSE_SECONDS,
    grace: process.env.DANAV_SANDBOX_RUN_GRACE_SECONDS,
  };
  process.env.DANAV_SANDBOX_IDLE_PAUSE_SECONDS = String(idleSeconds);
  process.env.DANAV_SANDBOX_RUN_GRACE_SECONDS = String(graceSeconds);
  try {
    return fn();
  } finally {
    if (prev.idle === undefined) delete process.env.DANAV_SANDBOX_IDLE_PAUSE_SECONDS;
    else process.env.DANAV_SANDBOX_IDLE_PAUSE_SECONDS = prev.idle;
    if (prev.grace === undefined) delete process.env.DANAV_SANDBOX_RUN_GRACE_SECONDS;
    else process.env.DANAV_SANDBOX_RUN_GRACE_SECONDS = prev.grace;
  }
}

test('a sandbox nobody has used is never judged: there is nothing to pause', () => {
  resetActivity();
  assert.equal(reasonToPause('ws-unknown', Date.now() + 10 * 60_000), null);
  assert.equal(msUntilPause('ws-unknown'), null);
});

test('nothing is paused while the idle window is still open', () => {
  resetActivity();
  withWindows(180, 90, () => {
    const t0 = 1_000_000;
    touch('ws-1', t0);
    assert.equal(reasonToPause('ws-1', t0 + 179_000), null);
    assert.equal(reasonToPause('ws-1', t0 + 180_000), 'idle');
  });
});

test('a finished run earns the SHORTER clock, not the idle one', () => {
  resetActivity();
  withWindows(600, 30, () => {
    const t0 = 1_000_000;
    noteRunFinished('ws-1', t0);
    // 40s later the long idle window is wide open, but the run grace has expired.
    assert.equal(reasonToPause('ws-1', t0 + 40_000), 'finished');
  });
});

test('any activity at all pushes the finished run back to the long clock', () => {
  resetActivity();
  withWindows(600, 30, () => {
    const t0 = 1_000_000;
    noteRunFinished('ws-1', t0);
    touch('ws-1', t0 + 20_000); // the user opened the files panel
    assert.equal(reasonToPause('ws-1', t0 + 40_000), null, 'the short clock is cancelled');
    assert.equal(reasonToPause('ws-1', t0 + 20_000 + 600_000), 'idle', 'the long clock runs from the activity');
  });
});

test('the countdown reports whichever clock is closer', () => {
  resetActivity();
  withWindows(600, 60, () => {
    const t0 = 1_000_000;
    noteRunFinished('ws-1', t0);
    assert.equal(msUntilPause('ws-1', t0), 60_000, 'the run grace is the nearer deadline');
    touch('ws-1', t0);
    assert.equal(msUntilPause('ws-1', t0), 600_000, 'only the idle window is left');
  });
});

test('forgetting a workspace clears both its clock and its state', () => {
  resetActivity();
  markRunning('ws-1');
  touch('ws-1', 1);
  assert.equal(stateOf('ws-1'), 'running');
  forget('ws-1');
  assert.equal(stateOf('ws-1'), null);
  assert.equal(reasonToPause('ws-1', Date.now() + 10_000_000), null);
});

// ---------------------------------------------------------------------------
// The sweep: who actually gets paused
// ---------------------------------------------------------------------------

/** A throwaway data dir with a couple of workspace records in it. */
function withRecords(records, fn) {
  const prev = process.env.DANAV_DATA_DIR;
  process.env.DANAV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danav-sweep-'));
  _resetStoreCache();
  resetActivity();
  for (const r of records) addWorkspaceRecord(r);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      _resetStoreCache();
      resetActivity();
      fs.rmSync(process.env.DANAV_DATA_DIR, { recursive: true, force: true });
      if (prev === undefined) delete process.env.DANAV_DATA_DIR;
      else process.env.DANAV_DATA_DIR = prev;
    });
}

const sbxRecord = (over = {}) => ({
  id: 'ws-1', name: 'one', kind: 'sandbox', root: '/home/user/one',
  sandboxId: 'sbx-1', autoRun: true, autoPause: true,
  createdAt: 1, updatedAt: 1, ...over,
});

test('the sweep pauses an idle sandbox and says why', async () => {
  await withRecords([sbxRecord()], async () => {
    const now = Date.now();
    markRunning('ws-1');
    touch('ws-1', now - 10 * 60_000);
    const calls = [];
    const paused = await sweepIdleSandboxes({
      now,
      pause: async (id) => {
        calls.push(id);
        return { sandboxId: id, state: 'paused', changed: true };
      },
    });
    assert.deepEqual(calls, ['sbx-1']);
    assert.deepEqual(paused.map((p) => [p.sandboxId, p.reason]), [['sbx-1', 'idle']]);
    assert.equal(stateOf('ws-1'), 'paused', 'we now know it is down, so we stop asking');
  });
});

test('a sandbox that was never seen running is not worth an API call', async () => {
  await withRecords([sbxRecord()], async () => {
    let called = 0;
    const paused = await sweepIdleSandboxes({
      now: Date.now() + 10 * 60_000,
      pause: async () => {
        called++;
        return { state: 'paused' };
      },
    });
    assert.equal(called, 0);
    assert.deepEqual(paused, []);
  });
});

test('a run in flight is never paused, and its clock is reset', async () => {
  await withRecords([sbxRecord()], async () => {
    const now = Date.now();
    markRunning('ws-1');
    touch('ws-1', now - 10 * 60_000);
    let called = 0;
    const paused = await sweepIdleSandboxes({
      now,
      isBusy: (id) => id === 'ws-1',
      pause: async () => {
        called++;
        return { state: 'paused' };
      },
    });
    assert.equal(called, 0, 'the sandbox is in use');
    assert.deepEqual(paused, []);
    assert.equal(reasonToPause('ws-1', now), null, 'and it is no longer considered idle');
  });
});

test('a workspace that opted out of auto-pause is left alone', async () => {
  await withRecords([sbxRecord({ autoPause: false })], async () => {
    markRunning('ws-1');
    touch('ws-1', Date.now() - 10 * 60_000);
    let called = 0;
    await sweepIdleSandboxes({ pause: async () => { called++; return { state: 'paused' }; } });
    assert.equal(called, 0);
  });
});

test('local workspaces and sandboxes already paused are skipped', async () => {
  await withRecords(
    [sbxRecord({ id: 'ws-local', kind: 'local', sandboxId: undefined }), sbxRecord({ id: 'ws-2', sandboxId: 'sbx-2' })],
    async () => {
      markRunning('ws-local'); // even a local one wrongly marked must not be paused
      markPaused('ws-2');
      touch('ws-local', Date.now() - 10 * 60_000);
      touch('ws-2', Date.now() - 10 * 60_000);
      const ids = [];
      await sweepIdleSandboxes({ pause: async (id) => { ids.push(id); return { state: 'paused' }; } });
      assert.deepEqual(ids, [], 'nothing was running');
    }
  );
});

test('a pause that fails does not stop the other workspaces being handled', async () => {
  await withRecords([sbxRecord({ id: 'ws-1', sandboxId: 'sbx-1' }), sbxRecord({ id: 'ws-2', sandboxId: 'sbx-2' })], async () => {
    const now = Date.now();
    for (const id of ['ws-1', 'ws-2']) {
      markRunning(id);
      touch(id, now - 10 * 60_000);
    }
    const paused = await sweepIdleSandboxes({
      now,
      pause: async (id) => {
        if (id === 'sbx-1') throw new Error('Novita is having a bad day');
        return { sandboxId: id, state: 'paused', changed: true };
      },
    });
    assert.deepEqual(paused.map((p) => p.sandboxId), ['sbx-2'], 'the second one still went down');
    assert.equal(stateOf('ws-1'), 'running', 'the failure is not mistaken for success');
  });
});

test('a sandbox that refuses to pause is retried on the next sweep', async () => {
  await withRecords([sbxRecord()], async () => {
    markRunning('ws-1');
    touch('ws-1', Date.now() - 10 * 60_000);
    const paused = await sweepIdleSandboxes({ pause: async () => ({ sandboxId: 'sbx-1', state: 'running', changed: false }) });
    assert.deepEqual(paused, []);
    assert.equal(stateOf('ws-1'), 'running', 'still running, so the next sweep tries again');
  });
});

// ---------------------------------------------------------------------------
// Normalizing what Novita returns
// ---------------------------------------------------------------------------

const sdkInfo = (over = {}) => ({
  sandboxId: 'sbx-1', templateId: 'tmpl', name: 'base', state: 'running',
  startedAt: new Date(1_000_000), endAt: new Date(2_000_000),
  cpuCount: 2, memoryMB: 512,
  metadata: { app: 'danav', workspace: 'ws-1', platform_metadata_region: 'us-phx-01', resource_pools: '["free"]' },
  ...over,
});

test('a sandbox Danav created is marked as such, and its workspace is linked', () => {
  const byId = new Map([['sbx-1', { id: 'ws-1', name: 'ghguyu', autoPause: true }]]);
  const s = normalizeSandbox(sdkInfo(), byId);
  assert.equal(s.isDanav, true);
  assert.equal(s.managed, true);
  assert.equal(s.workspaceId, 'ws-1');
  assert.equal(s.workspaceName, 'ghguyu');
  assert.equal(s.state, 'running');
  assert.equal(s.cpuCount, 2);
  assert.equal(s.startedAt, 1_000_000);
  assert.equal(s.endAt, 2_000_000);
  assert.equal(s.autoPause, true);
});

test('an orphan is shown but is not "managed", and is never auto-paused', () => {
  // This is the whole point of the account-wide view: the sandbox is real and
  // running, but no workspace in this app points at it any more.
  const s = normalizeSandbox(sdkInfo(), new Map());
  assert.equal(s.isDanav, true, 'Danav made it once');
  assert.equal(s.managed, false, 'but nothing owns it now');
  assert.equal(s.workspaceId, null);
  assert.equal(s.autoPause, null, 'so there is no auto-pause setting to honour');
});

test("Novita's own bookkeeping is kept out of the payload sent to the browser", () => {
  const s = normalizeSandbox(sdkInfo(), new Map());
  assert.deepEqual(s.metadata, { app: 'danav', workspace: 'ws-1' });
  assert.ok(!('platform_metadata_region' in s.metadata));
  assert.ok(!('resource_pools' in s.metadata));
});

test('a sandbox from somewhere else is labelled as not-Danav', () => {
  const s = normalizeSandbox(sdkInfo({ metadata: { app: 'other-tool' } }), new Map());
  assert.equal(s.isDanav, false);
  assert.equal(s.managed, false);
});

test('a missing template or dates does not break the shape', () => {
  const s = normalizeSandbox(sdkInfo({ templateId: undefined, name: undefined, startedAt: null, endAt: null }), new Map());
  assert.equal(s.templateId, null);
  assert.equal(s.name, null);
  assert.equal(s.startedAt, null);
  assert.equal(s.endAt, null);
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

async function withAgentServer(fn) {
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/agent`;
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-danav-agent': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  try {
    return await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('routes: the sandbox list is honest when no key is configured', async () => {
  const prev = process.env.NOVITA_API_KEY;
  delete process.env.NOVITA_API_KEY;
  try {
    await withAgentServer(async (call) => {
      const res = await call('GET', '/sandboxes');
      assert.equal(res.status, 200);
      assert.equal(res.json.configured, false);
      assert.deepEqual(res.json.sandboxes, []);
      assert.deepEqual(res.json.totals, { all: 0, running: 0, paused: 0, orphans: 0 });
    });
  } finally {
    if (prev !== undefined) process.env.NOVITA_API_KEY = prev;
  }
});

test('routes: pausing without a key is a clear 400, not a crash', async () => {
  const prev = process.env.NOVITA_API_KEY;
  delete process.env.NOVITA_API_KEY;
  try {
    await withAgentServer(async (call) => {
      const res = await call('POST', '/sandboxes/sbx-1/pause');
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'no_key');
      assert.match(res.json.error, /NOVITA_API_KEY/);
    });
  } finally {
    if (prev !== undefined) process.env.NOVITA_API_KEY = prev;
  }
});

test('routes: the status of a local workspace is "local", not an error', async () => {
  await withRecords([sbxRecord({ id: 'ws-local', kind: 'local', sandboxId: undefined })], async () => {
    await withAgentServer(async (call) => {
      const res = await call('GET', '/sandboxes/status?workspaceId=ws-local');
      assert.equal(res.status, 200);
      assert.equal(res.json.status.state, 'local');
    });
  });
});

test('routes: a sandbox workspace with no sandbox yet reports "none"', async () => {
  await withRecords([sbxRecord({ id: 'ws-fresh', sandboxId: undefined })], async () => {
    await withAgentServer(async (call) => {
      const res = await call('GET', '/sandboxes/status?workspaceId=ws-fresh');
      assert.equal(res.status, 200);
      assert.equal(res.json.status.state, 'none');
    });
  });
});

test('routes: an unknown workspace reports "missing" rather than throwing', async () => {
  await withRecords([], async () => {
    await withAgentServer(async (call) => {
      const res = await call('GET', '/sandboxes/status?workspaceId=ws-nope');
      assert.equal(res.status, 200);
      assert.equal(res.json.status.state, 'missing');
    });
  });
});

test('routes: status needs a workspace id', async () => {
  await withAgentServer(async (call) => {
    const res = await call('GET', '/sandboxes/status');
    assert.equal(res.status, 400);
  });
});

test('routes: the sandbox routes still sit behind the agent guard', async () => {
  // These routes can destroy a VM, so they must not answer a plain browser tab.
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { runSearchTool: async () => ({ success: false }) });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/agent/sandboxes`;
    const withoutHeader = await fetch(url);
    assert.equal(withoutHeader.status, 403, 'no x-danav-agent header: refused');
    const withHeader = await fetch(url, { headers: { 'x-danav-agent': '1' } });
    assert.equal(withHeader.status, 200, 'the app itself gets through');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
