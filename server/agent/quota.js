/**
 * Per-key, per-model request budgeting.
 *
 * A Gemini key is not rate-limited as a key. It is limited per MODEL: each one
 * gets its own requests-per-minute and requests-per-day allowance, so eight keys
 * across four models is thirty-two independent budgets, not one. The old
 * failover could not see any of that — it sent a request, waited for a 429, and
 * only then tried the next key. With a 5 RPM limit that means the sixth call of
 * a minute is always wasted, every minute, on every key in turn.
 *
 * This module keeps the ledger so the choice can be made BEFORE the request:
 * pick a (key, model) pair that still has room, and spend nothing discovering
 * the ones that do not.
 *
 * Two clocks, because the provider has two:
 *   - RPM is a sliding sixty-second window. A fixed bucket would let eleven
 *     requests through either side of a boundary on a limit of five.
 *   - RPD is a calendar count that resets at midnight Pacific, which is when
 *     Google resets it — not at the user's midnight, and not 24h after the
 *     first call.
 *
 * The day count is persisted, because a restart does not give the quota back.
 * The minute window is not: it is at most sixty seconds old and reconstructing
 * it is not worth a disk read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

/** Google's documented free-tier shape for the Flash models, per key, per model. */
export const DEFAULT_LIMITS = { rpm: 5, rpd: 20 };

/** How long a pair is left alone after the provider says it is busy. */
const BUSY_MS = 20_000;
/** A 429 with no Retry-After means the minute window is the thing that is full. */
const RATE_LIMITED_MS = 60_000;
/** Never trust a provider's Retry-After beyond this; it is sometimes hours. */
const MAX_COOLDOWN_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/** Writes are debounced: a busy run must not turn into a write per request. */
const FLUSH_MS = 2_000;

const file = () => path.join(dataDir(), 'quota.json');

/**
 * The calendar day a request counts against, in Pacific time.
 *
 * Intl is the only correct way to do this: Pacific is UTC-8 or UTC-7 depending
 * on the date, and a hard-coded offset silently moves the reset by an hour for
 * eight months of the year.
 */
export function quotaDay(at = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

const keyOf = (providerId, credentialIndex, model) =>
  `${String(providerId || '')}\u0000${Number(credentialIndex) || 0}\u0000${String(model || '')}`;

/** state: key -> { day, used, minute: number[], cooldownUntil, lastStatus } */
const state = new Map();
let loadedFrom = '';
let flushTimer = null;

function load() {
  const target = file();
  if (loadedFrom === target) return;
  loadedFrom = target;
  state.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const today = quotaDay();
    for (const [key, value] of Object.entries(raw?.pairs || {})) {
      // Yesterday's counts are not a smaller version of today's; they are gone.
      if (!value || value.day !== today) continue;
      state.set(key, {
        day: today,
        used: Number.isFinite(value.used) ? Math.max(0, Math.floor(value.used)) : 0,
        minute: [],
        cooldownUntil: 0,
        lastStatus: 0,
      });
    }
  } catch {
    /* No ledger yet, or it is unreadable. Starting empty only costs accuracy today. */
  }
}

function flushSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const pairs = {};
    for (const [key, value] of state) {
      if (value.used > 0) pairs[key] = { day: value.day, used: value.used };
    }
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify({ pairs }, null, 0));
    } catch {
      /* The ledger is an optimisation. Losing it costs a few wasted requests, never correctness. */
    }
  }, FLUSH_MS);
  flushTimer.unref?.();
}

function entry(providerId, credentialIndex, model, at = Date.now()) {
  load();
  const key = keyOf(providerId, credentialIndex, model);
  const today = quotaDay(at);
  let value = state.get(key);
  if (!value) {
    value = { day: today, used: 0, minute: [], cooldownUntil: 0, lastStatus: 0 };
    state.set(key, value);
  } else if (value.day !== today) {
    value.day = today;
    value.used = 0;
  }
  // Drop anything that has fallen out of the sliding window.
  if (value.minute.length) {
    const cutoff = at - MINUTE_MS;
    if (value.minute[0] <= cutoff) value.minute = value.minute.filter((t) => t > cutoff);
  }
  return value;
}

/**
 * The limits for one model on one provider.
 *
 * A provider may carry `quota.limits`, keyed by model id with `*` as the
 * fallback. Anything missing or nonsensical falls back to the documented free
 * tier rather than to "unlimited", because guessing high is what produces the
 * 429 this module exists to avoid.
 */
export function limitsFor(provider, model) {
  const configured = provider?.quota?.limits || {};
  const raw = configured[model] || configured['*'] || {};
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return { rpm: num(raw.rpm, DEFAULT_LIMITS.rpm), rpd: num(raw.rpd, DEFAULT_LIMITS.rpd) };
}

/** What is left on one (key, model) pair right now, and when it frees up. */
export function headroom(provider, credentialIndex, model, at = Date.now()) {
  const { rpm, rpd } = limitsFor(provider, model);
  const value = entry(provider?.id, credentialIndex, model, at);
  const minuteLeft = Math.max(0, rpm - value.minute.length);
  const dayLeft = Math.max(0, rpd - value.used);
  // The oldest request in the window is the one whose expiry frees a slot.
  const minuteFreeAt = minuteLeft > 0 ? 0 : (value.minute[0] || at) + MINUTE_MS;
  const cooling = value.cooldownUntil > at ? value.cooldownUntil : 0;
  const readyAt = Math.max(minuteFreeAt, cooling);
  return {
    rpm,
    rpd,
    minuteUsed: value.minute.length,
    dayUsed: value.used,
    minuteLeft,
    dayLeft,
    cooling: cooling > 0,
    // A day-exhausted pair is not "ready later today" — it is done until reset.
    available: minuteLeft > 0 && dayLeft > 0 && !cooling,
    readyAt: dayLeft > 0 ? readyAt : Infinity,
  };
}

/**
 * Order every (key, model) pair this request could use, best first.
 *
 * Preference, in order:
 *   1. the model that was actually asked for — switching model is a visible
 *      change in behaviour, so it is a fallback, never an optimisation;
 *   2. within a model, the key with the most room left today, so the keys wear
 *      down evenly instead of one being exhausted while seven sit idle;
 *   3. models in the order the user listed them.
 *
 * Pairs with no room are still returned, after the usable ones and sorted by
 * when they free up. A caller that has exhausted everything should fail against
 * the pair that recovers soonest rather than refuse to try at all.
 */
export function planAttempts(provider, model, { credentialCount = 1, models = [], at = Date.now() } = {}) {
  const keys = Math.max(1, Number(credentialCount) || 1);
  const chain = [model, ...models.filter((m) => m && m !== model)];
  const candidates = [];
  for (let m = 0; m < chain.length; m++) {
    for (let k = 0; k < keys; k++) {
      const room = headroom(provider, k, chain[m], at);
      candidates.push({ model: chain[m], credentialIndex: k, modelRank: m, ...room });
    }
  }
  return candidates.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available) {
      if (a.modelRank !== b.modelRank) return a.modelRank - b.modelRank;
      if (a.dayLeft !== b.dayLeft) return b.dayLeft - a.dayLeft;
      return a.minuteUsed - b.minuteUsed;
    }
    if (a.readyAt !== b.readyAt) return a.readyAt - b.readyAt;
    return a.modelRank - b.modelRank;
  });
}

/** Count a request that is about to be sent. Called before the fetch, not after. */
export function recordRequest(providerId, credentialIndex, model, at = Date.now()) {
  const value = entry(providerId, credentialIndex, model, at);
  value.minute.push(at);
  value.used += 1;
  flushSoon();
  return value;
}

/**
 * Park a pair the provider has just refused.
 *
 * A 429 means this minute is full, so the window is the right wait. A 5xx is
 * the provider being busy rather than this pair being over budget, so it gets a
 * much shorter rest — long enough to stop hammering, short enough that a blip
 * does not cost the key for a minute. An explicit Retry-After wins over both,
 * clamped, because providers do sometimes return absurd values.
 */
export function recordBusy(providerId, credentialIndex, model, { status = 0, retryAfterMs = 0, at = Date.now() } = {}) {
  const value = entry(providerId, credentialIndex, model, at);
  const requested = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : (status === 429 ? RATE_LIMITED_MS : BUSY_MS);
  value.cooldownUntil = Math.max(value.cooldownUntil, at + Math.min(MAX_COOLDOWN_MS, requested));
  value.lastStatus = Number(status) || 0;
  // A 429 means the provider counted requests we did not. Fill the local window
  // so the next choice believes it, instead of trying the same pair again.
  if (status === 429) {
    const { rpm } = limitsFor({ id: providerId }, model);
    while (value.minute.length < rpm) value.minute.push(at);
  }
  return value;
}

/** Clear a cooldown after a pair succeeds, so one blip does not sideline it. */
export function recordSuccess(providerId, credentialIndex, model, at = Date.now()) {
  const value = entry(providerId, credentialIndex, model, at);
  value.cooldownUntil = 0;
  value.lastStatus = 0;
  return value;
}

/**
 * Everything the user needs to see: per model, per key, and the totals.
 *
 * Totals are summed over pairs, which is what the user actually has — four
 * models across eight keys at 5/20 each is 160 requests a day, not 20.
 */
export function snapshot(providers = [], at = Date.now()) {
  load();
  const out = [];
  for (const provider of providers) {
    if (!provider?.quota?.enabled) continue;
    const credentialCount = Math.max(1, Number(provider.apiKeyCount) || (provider.apiKeys?.length ?? 0) || 1);
    const models = (provider.models || []).map((m) => m.id);
    const perModel = models.map((model) => {
      const { rpm, rpd } = limitsFor(provider, model);
      const keys = [];
      for (let k = 0; k < credentialCount; k++) keys.push({ credentialIndex: k, ...headroom(provider, k, model, at) });
      return {
        model,
        rpm,
        rpd,
        minuteUsed: keys.reduce((n, key) => n + key.minuteUsed, 0),
        minuteLimit: rpm * credentialCount,
        dayUsed: keys.reduce((n, key) => n + key.dayUsed, 0),
        dayLimit: rpd * credentialCount,
        keysAvailable: keys.filter((key) => key.available).length,
        keys,
      };
    });
    out.push({
      providerId: provider.id,
      name: provider.name,
      credentialCount,
      resetsAt: 'midnight America/Los_Angeles',
      day: quotaDay(at),
      minuteUsed: perModel.reduce((n, m) => n + m.minuteUsed, 0),
      minuteLimit: perModel.reduce((n, m) => n + m.minuteLimit, 0),
      dayUsed: perModel.reduce((n, m) => n + m.dayUsed, 0),
      dayLimit: perModel.reduce((n, m) => n + m.dayLimit, 0),
      models: perModel,
    });
  }
  return out;
}

/** Test seam: drop everything in memory and re-read on next use. */
export function resetQuotaState() {
  state.clear();
  loadedFrom = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
