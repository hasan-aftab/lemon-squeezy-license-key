import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Tiny JSON-file store. Good for one server process (VPS, Render/Railway with a
 * persistent disk). All mutations are synchronous, so read-modify-write sequences
 * inside a single function are atomic with respect to other requests.
 *
 * Swap this module for Redis/Postgres/SQLite to run several instances or on
 * serverless platforms with no persistent disk. The rest of the app only uses
 * the functions exported here.
 */

const FILE = path.join(config.paths.data, "store.json");

const empty = () => ({
  sessions: {}, // sidHash -> session
  pending: {}, // pendingHash -> { keyEnc, keyHash, instanceName, expiresAt }
  deviceCookies: {}, // keyHash -> { deviceId -> { instanceId, name, at } }
  registry: {}, // keyHash -> { instanceId -> { name, createdAt } }  (fallback device list)
  removals: {}, // keyHash -> [{ id, at }]
  revoked: { keys: {}, orders: {} }, // keyHash/orderId -> timestamp
});

let state = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { ...empty(), ...raw, revoked: { ...empty().revoked, ...(raw.revoked || {}) } };
  } catch {
    return empty();
  }
}

function save() {
  fs.mkdirSync(config.paths.data, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// --- sessions ---------------------------------------------------------------
export const getSession = (h) => state.sessions[h] || null;
export function putSession(h, s) {
  state.sessions[h] = s;
  save();
}
export function updateSession(h, patch) {
  if (!state.sessions[h]) return;
  Object.assign(state.sessions[h], patch);
  save();
}
export function deleteSession(h) {
  if (state.sessions[h]) {
    delete state.sessions[h];
    save();
  }
}
export const allSessions = () => Object.entries(state.sessions);

export function deleteSessionsWhere(pred) {
  let n = 0;
  for (const [h, s] of Object.entries(state.sessions)) {
    if (pred(s)) {
      delete state.sessions[h];
      n++;
    }
  }
  if (n) save();
  return n;
}

// --- pending (device-limit screen) ------------------------------------------
export const getPending = (h) => state.pending[h] || null;
export function putPending(h, p) {
  state.pending[h] = p;
  save();
}
export function deletePending(h) {
  if (state.pending[h]) {
    delete state.pending[h];
    save();
  }
}

// --- device cookies: lets a returning browser reuse its activation -----------
export const getDeviceCookie = (keyHash, deviceId) => state.deviceCookies[keyHash]?.[deviceId] || null;
export function putDeviceCookie(keyHash, deviceId, rec) {
  (state.deviceCookies[keyHash] ||= {})[deviceId] = rec;
  save();
}
export function forgetInstance(keyHash, instanceId) {
  const dc = state.deviceCookies[keyHash];
  if (dc) {
    for (const [id, rec] of Object.entries(dc)) if (rec.instanceId === instanceId) delete dc[id];
  }
  if (state.registry[keyHash]) delete state.registry[keyHash][instanceId];
  save();
}

// --- local device registry (used only when no Lemon API key is configured) ---
export function registerInstance(keyHash, instanceId, name) {
  (state.registry[keyHash] ||= {})[instanceId] = { name, createdAt: new Date().toISOString() };
  save();
}
export const registeredInstances = (keyHash) =>
  Object.entries(state.registry[keyHash] || {}).map(([id, v]) => ({ id, ...v }));

// --- removal quota -------------------------------------------------------------
/**
 * Atomically claim one removal slot. Returns the claim id, or null if the key has
 * used up its quota in the window. Call releaseRemoval() if the removal then fails.
 */
export function reserveRemoval(keyHash, now = Date.now()) {
  const { maxRemovals, removalWindowMs } = config.policy;
  const list = (state.removals[keyHash] || []).filter((r) => now - r.at < removalWindowMs);
  if (list.length >= maxRemovals) {
    state.removals[keyHash] = list;
    return null;
  }
  const claim = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now };
  list.push(claim);
  state.removals[keyHash] = list;
  save();
  return claim.id;
}
export function releaseRemoval(keyHash, claimId) {
  state.removals[keyHash] = (state.removals[keyHash] || []).filter((r) => r.id !== claimId);
  save();
}
export function removalsLeft(keyHash, now = Date.now()) {
  const { maxRemovals, removalWindowMs } = config.policy;
  const used = (state.removals[keyHash] || []).filter((r) => now - r.at < removalWindowMs).length;
  return Math.max(0, maxRemovals - used);
}

// --- revocation (webhooks) -----------------------------------------------------
export function revokeKey(keyHash) {
  state.revoked.keys[keyHash] = Date.now();
  save();
}
export function unrevokeKey(keyHash) {
  if (state.revoked.keys[keyHash]) {
    delete state.revoked.keys[keyHash];
    save();
  }
}
export function revokeOrder(orderId) {
  state.revoked.orders[String(orderId)] = Date.now();
  save();
}
export const isRevoked = ({ keyHash, orderId }) =>
  Boolean(state.revoked.keys[keyHash] || (orderId != null && state.revoked.orders[String(orderId)]));

// --- housekeeping --------------------------------------------------------------
export function cleanup(now = Date.now()) {
  let changed = false;
  for (const [h, s] of Object.entries(state.sessions)) {
    if (s.expiresAt <= now) {
      delete state.sessions[h];
      changed = true;
    }
  }
  for (const [h, p] of Object.entries(state.pending)) {
    if (p.expiresAt <= now) {
      delete state.pending[h];
      changed = true;
    }
  }
  for (const [k, list] of Object.entries(state.removals)) {
    const kept = list.filter((r) => now - r.at < config.policy.removalWindowMs);
    if (kept.length !== list.length) {
      state.removals[k] = kept.length ? kept : undefined;
      if (!kept.length) delete state.removals[k];
      changed = true;
    }
  }
  if (changed) save();
}
