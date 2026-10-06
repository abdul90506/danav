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

/**
 * The free-tier allowance of ONE key on ONE model.
 *
 * Five requests a minute and twenty a day, which is what these keys actually
 * get; published tables disagree with each other and with the endpoint, so the
 * observed figure wins. A starting point only: `learnLimits` replaces it with
 * whatever the provider states in a refusal, and nothing is ever refused on
 * these numbers alone.
 */
export const DEFAULT_LIMITS = { rpm: 5, rpd: 20 };

/**
 * The model id that means "you choose".
 *
 * Picking a specific model is picking a specific budget, and the user cannot
 * know which of the four has room at the moment they press send. This id is
 * offered in the model picker and resolved here, per request, to whichever
 * real model still has quota. It is never sent to the provider.
 */
export const AUTO_MODEL_ID = 'auto';

export const isAutoModel = (model) => String(model || '').trim().toLowerCase() === AUTO_MODEL_ID;

/** The models a request can really be sent to, in the order the user listed them. */
export function routableModels(provider) {
  return (provider?.models || [])
    .map((model) => (typeof model === 'string' ? model : model?.id))
    .filter((id) => id && !isAutoModel(id));
}

/** The picker entry for the router itself, built from whatever the provider holds. */
export function autoModelEntry(provider) {
  const models = routableModels(provider);
  const keys = Math.max(1, Number(provider?.apiKeyCount) || (provider?.apiKeys?.length ?? 0) || 1);
  const perDay = models.reduce((total, model) => total + limitsFor(provider, model).rpd * keys, 0);
  return {
    id: AUTO_MODEL_ID,
    providerId: provider?.id,
    name: 'Auto — whichever model has quota',
    description: models.length
      ? `Routes each request across ${models.length} models and ${keys} ${keys === 1 ? 'key' : 'keys'}: about ${perDay} requests a day. Skips anything already at its limit.`
      : 'Routes each request to whichever model and key still has quota.',
    supportsThinking: (provider?.models || []).some((model) => model?.supportsThinking === true) || undefined,
  };
}

/**
 * How long a MODEL is left alone after the provider says it is busy.
 *
 * Measured against this provider: a 503 ("this model is currently experiencing
 * high demand") is about the model, not the key — the same instant, two keys
 * get the same answer, and a different model answers fine. It also clears in
 * seconds. So a busy model is skipped briefly and the request moves on, rather
 * than every key being spent discovering the same thing. Repeats escalate.
 */
const MODEL_BUSY_MS = 2_500;
const MODEL_BUSY_MAX_MS = 20_000;
/** Consecutive 503s stop counting as consecutive after this long. */
const BUSY_STREAK_MS = 60_000;
/** A pair that just 503'd goes to the back of the queue, but not out of it. */
const BUSY_MS = 1_500;
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

/**
 * When today's count goes back to zero, as a timestamp.
 *
 * Pacific midnight is not a fixed offset from UTC, so the boundary is found by
 * stepping forward until the day string changes and then narrowing to the
 * minute. That is correct on the two DST days a year, which arithmetic is not.
 */
export function nextDayResetAt(at = Date.now()) {
  const today = quotaDay(at);
  const STEP = 30 * 60_000;
  for (let i = 1; i <= 100; i++) {
    const probe = at + i * STEP;
    if (quotaDay(probe) === today) continue;
    let before = probe - STEP;
    let after = probe;
    while (after - before > 60_000) {
      const mid = Math.floor((before + after) / 2);
      if (quotaDay(mid) === today) before = mid;
      else after = mid;
    }
    return after;
  }
  return at + 24 * 60 * 60_000;
}

const keyOf = (providerId, credentialIndex, model) =>
  `${String(providerId || '')}\u0000${Number(credentialIndex) || 0}\u0000${String(model || '')}`;

/** state: key -> { day, used, minute: number[], cooldownUntil, lastStatus, refused } */
const state = new Map();
/** provider+model -> { busyUntil, strikes, lastBusyAt }. A 503 is model-wide. */
const modelState = new Map();
/** provider+model -> { rpm, rpd } exactly as the provider stated them. */
const learned = new Map();
let loadedFrom = '';
let flushTimer = null;

function load() {
  const target = file();
  if (loadedFrom === target) return;
  loadedFrom = target;
  state.clear();
  learned.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const today = quotaDay();
    for (const [key, value] of Object.entries(raw?.limits || {})) {
      const entry = {};
      for (const field of ['rpm', 'rpd']) {
        const n = Math.floor(Number(value?.[field]));
        if (Number.isFinite(n) && n > 0) entry[field] = n;
      }
      if (Object.keys(entry).length) learned.set(key, entry);
    }
    for (const [key, value] of Object.entries(raw?.pairs || {})) {
      // Yesterday's counts are not a smaller version of today's; they are gone.
      if (!value || value.day !== today) continue;
      state.set(key, {
        day: today,
        used: Number.isFinite(value.used) ? Math.max(0, Math.floor(value.used)) : 0,
        minute: [],
        cooldownUntil: 0,
        lastStatus: 0,
        // Whether the provider itself has refused this pair today, as opposed
        // to Danav's own estimate saying it should be full.
        refused: value.refused === true,
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
      if (value.used > 0 || value.refused) {
        pairs[key] = { day: value.day, used: value.used, ...(value.refused ? { refused: true } : {}) };
      }
    }
    const limits = Object.fromEntries(learned);
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify({ pairs, limits }, null, 0));
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
    value = { day: today, used: 0, minute: [], cooldownUntil: 0, lastStatus: 0, refused: false };
    state.set(key, value);
  } else if (value.day !== today) {
    value.day = today;
    value.used = 0;
    value.refused = false;
  }
  // Drop anything that has fallen out of the sliding window.
  if (value.minute.length) {
    const cutoff = at - MINUTE_MS;
    if (value.minute[0] <= cutoff) value.minute = value.minute.filter((t) => t > cutoff);
  }
  return value;
}

/** How long this model should be left alone, if at all. */
export function modelBusyUntil(providerId, model, at = Date.now()) {
  const value = modelState.get(`${String(providerId || '')}\u0000${String(model || '')}`);
  return value && value.busyUntil > at ? value.busyUntil : 0;
}

/** Note that the provider says this model is busy right now. */
function markModelBusy(providerId, model, at, retryAfterMs = 0) {
  const key = `${String(providerId || '')}\u0000${String(model || '')}`;
  const value = modelState.get(key) || { busyUntil: 0, strikes: 0, lastBusyAt: 0 };
  // Only a run of failures means the model is really struggling; an isolated
  // one a minute later starts again from the short wait.
  value.strikes = at - value.lastBusyAt <= BUSY_STREAK_MS ? value.strikes + 1 : 1;
  value.lastBusyAt = at;
  const backoff = Math.min(MODEL_BUSY_MAX_MS, MODEL_BUSY_MS * 2 ** (value.strikes - 1));
  value.busyUntil = Math.max(value.busyUntil, at + Math.max(backoff, Math.min(MAX_COOLDOWN_MS, retryAfterMs)));
  modelState.set(key, value);
  return value;
}

/** A model that answers is not busy, whatever it did a moment ago. */
function clearModelBusy(providerId, model) {
  modelState.delete(`${String(providerId || '')}\u0000${String(model || '')}`);
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
  // What the provider told us in a refusal beats both the setting and the
  // default: it is the only number that is not a guess.
  const taught = learned.get(`${String(provider?.id || '')}\u0000${String(model || '')}`) || {};
  return {
    rpm: num(taught.rpm, num(raw.rpm, DEFAULT_LIMITS.rpm)),
    rpd: num(taught.rpd, num(raw.rpd, DEFAULT_LIMITS.rpd)),
    // True once the provider has stated these numbers itself.
    confirmed: Boolean(taught.rpm || taught.rpd),
  };
}

/**
 * Take the provider at its word about its own limits.
 *
 * A Google 429 carries a QuotaFailure listing the metric and its value, which
 * is better information than anything a user can type into Settings. Learning
 * it means the planner stops guessing after the first refusal, and that a
 * limit raised or lowered upstream is picked up without anyone editing a file.
 */
export function learnLimits(providerId, model, body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return null;
  const found = {};
  for (const detail of details) {
    for (const violation of Array.isArray(detail?.violations) ? detail.violations : []) {
      const id = String(violation?.quotaId || violation?.quotaMetric || '');
      const value = Math.floor(Number(violation?.quotaValue));
      if (!Number.isFinite(value) || value <= 0) continue;
      if (/perminute/i.test(id)) found.rpm = value;
      else if (/perday/i.test(id)) found.rpd = value;
    }
  }
  if (!found.rpm && !found.rpd) return null;
  const key = `${String(providerId || '')}\u0000${String(model || '')}`;
  const next = { ...(learned.get(key) || {}), ...found };
  learned.set(key, next);
  flushSoon();
  return next;
}

/** What is left on one (key, model) pair right now, and when it frees up. */
export function headroom(provider, credentialIndex, model, at = Date.now()) {
  const { rpm, rpd, confirmed } = limitsFor(provider, model);
  const value = entry(provider?.id, credentialIndex, model, at);
  const minuteLeft = Math.max(0, rpm - value.minute.length);
  const dayLeft = Math.max(0, rpd - value.used);
  // The oldest request in the window is the one whose expiry frees a slot.
  const minuteFreeAt = minuteLeft > 0 ? 0 : (value.minute[0] || at) + MINUTE_MS;
  const cooling = value.cooldownUntil > at ? value.cooldownUntil : 0;
  const readyAt = Math.max(minuteFreeAt, cooling);
  const busyUntil = modelBusyUntil(provider?.id, model, at);
  return {
    rpm,
    rpd,
    minuteUsed: value.minute.length,
    dayUsed: value.used,
    minuteLeft,
    dayLeft,
    cooling: cooling > 0,
    // The model is struggling, which is not the same as this pair being spent:
    // it is a reason to prefer another model, never a reason to refuse to work.
    busy: busyUntil > at,
    busyUntil,
    // Whether this budget is the provider's own word or Danav's assumption.
    // Nothing is ever refused on an assumption alone.
    confirmed: confirmed || value.refused === true,
    refused: value.refused === true,
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
  // `auto` is a request to choose, not something a provider can answer, so it
  // never enters the chain — it simply leaves the first real model preferred.
  const chain = [];
  for (const candidate of [model, ...models]) {
    if (!candidate || isAutoModel(candidate) || chain.includes(candidate)) continue;
    chain.push(candidate);
  }
  if (!chain.length) return [];
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
      // A model the provider has just called busy is still usable, but anything
      // not busy is a better bet right now — that is the whole reason a 503
      // costs one request here instead of one per key.
      if (a.busy !== b.busy) return a.busy ? 1 : -1;
      if (a.busy && a.busyUntil !== b.busyUntil) return a.busyUntil - b.busyUntil;
      if (a.modelRank !== b.modelRank) return a.modelRank - b.modelRank;
      if (a.dayLeft !== b.dayLeft) return b.dayLeft - a.dayLeft;
      return a.minuteUsed - b.minuteUsed;
    }
    // Nothing is free: prefer whatever the provider has not actually refused,
    // because that budget is only an estimate and may well be wrong.
    if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
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
export function recordBusy(providerId, credentialIndex, model, { status = 0, retryAfterMs = 0, at = Date.now(), body = '' } = {}) {
  const value = entry(providerId, credentialIndex, model, at);
  value.lastStatus = Number(status) || 0;
  if (status === 429) {
    // The provider counted requests Danav did not. Believe it: fill the local
    // window, remember that this pair was genuinely refused, and take any
    // limit it stated while it is being explicit about them.
    if (body) learnLimits(providerId, model, body);
    const requested = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : RATE_LIMITED_MS;
    value.cooldownUntil = Math.max(value.cooldownUntil, at + Math.min(MAX_COOLDOWN_MS, requested));
    value.refused = true;
    const { rpm } = limitsFor({ id: providerId }, model);
    while (value.minute.length < rpm) value.minute.push(at);
    return value;
  }
  // Anything else — 503 and friends — is the model being busy, not this key
  // being over budget. Skip the model for a moment and move on immediately.
  value.cooldownUntil = Math.max(value.cooldownUntil, at + BUSY_MS);
  markModelBusy(providerId, model, at, Number(retryAfterMs) || 0);
  return value;
}

/** Clear a cooldown after a pair succeeds, so one blip does not sideline it. */
export function recordSuccess(providerId, credentialIndex, model, at = Date.now()) {
  const value = entry(providerId, credentialIndex, model, at);
  value.cooldownUntil = 0;
  value.lastStatus = 0;
  // A model that answers is not busy, whatever it said a second ago.
  clearModelBusy(providerId, model);
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
    const models = routableModels(provider);
    const perModel = models.map((model) => {
      const { rpm, rpd, confirmed } = limitsFor(provider, model);
      const busyUntil = modelBusyUntil(provider.id, model, at);
      const keys = [];
      for (let k = 0; k < credentialCount; k++) {
        const room = headroom(provider, k, model, at);
        keys.push({
          credentialIndex: k,
          ...room,
          // JSON has no Infinity: a day-exhausted pair reports null, meaning
          // "not until the daily reset", which is a different wait entirely.
          readyAt: Number.isFinite(room.readyAt) ? room.readyAt : null,
          readyInMs: Number.isFinite(room.readyAt) ? Math.max(0, room.readyAt - at) : null,
        });
      }
      return {
        model,
        rpm,
        rpd,
        // Whether these numbers are the provider's own, or Danav's estimate.
        confirmed,
        // The provider said this model is busy; it is skipped, not spent.
        busyInMs: busyUntil > at ? busyUntil - at : 0,
        minuteUsed: keys.reduce((n, key) => n + key.minuteUsed, 0),
        minuteLimit: rpm * credentialCount,
        dayUsed: keys.reduce((n, key) => n + key.dayUsed, 0),
        dayLimit: rpd * credentialCount,
        keysAvailable: keys.filter((key) => key.available).length,
        // How long until this model can take a request again, when none can now.
        readyInMs: keys.some((key) => key.available)
          ? 0
          : keys.reduce((soonest, key) => (key.readyInMs === null ? soonest : Math.min(soonest, key.readyInMs)), Infinity),
        keys,
      };
    });
    out.push({
      providerId: provider.id,
      name: provider.name,
      credentialCount,
      resetsAt: 'midnight America/Los_Angeles',
      resetsAtMs: nextDayResetAt(at),
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
  modelState.clear();
  learned.clear();
  loadedFrom = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
