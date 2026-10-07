import { config } from "./config.js";
import * as store from "./store.js";
import * as lemon from "./lemon.js";
import { decrypt, encrypt, hashKey, hashToken, randomToken } from "./crypto.js";

export const SESSION_COOKIE = "rv_session";
export const DEVICE_COOKIE = "rv_device";
export const PENDING_COOKIE = "rv_pending";

const DEVICE_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;

export function cookieOptions(maxAge) {
  return {
    httpOnly: true, // not readable from page JavaScript
    secure: config.isProd, // HTTPS-only in production
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

// --- identity ----------------------------------------------------------------

/** Who the watermark names. Order number prefers the human-facing one from the API. */
export function identityFrom(meta, order) {
  return {
    customerName: String(meta.customer_name || "Customer").slice(0, 80),
    customerEmail: String(meta.customer_email || "").slice(0, 120),
    orderNumber: String(order?.orderNumber ?? meta.order_id ?? ""),
  };
}

// --- session lifecycle -------------------------------------------------------

/** Create a server-side session and set the cookie. Returns the session record. */
export function createSession(res, { licenseKey, instanceId, instanceName, license, meta, order }) {
  const now = Date.now();
  const sid = randomToken();
  const session = {
    keyEnc: encrypt(licenseKey),
    keyHash: hashKey(licenseKey),
    licenseKeyId: license.id,
    instanceId,
    instanceName,
    orderId: meta.order_id,
    variantId: String(meta.variant_id),
    ...identityFrom(meta, order),
    createdAt: now,
    expiresAt: now + config.policy.sessionMs,
    lastValidatedAt: now,
  };
  store.putSession(hashToken(sid), session);
  res.cookie(SESSION_COOKIE, sid, cookieOptions(config.policy.sessionMs));
  return session;
}

export function clearSession(req, res) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) store.deleteSession(hashToken(sid));
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Stable per-browser id so a returning browser reuses its activation instead of using a new one. */
export function ensureDeviceId(req, res) {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
    id = randomToken(24);
    res.cookie(DEVICE_COOKIE, id, cookieOptions(DEVICE_COOKIE_MS));
  }
  return id;
}

// --- pending "device limit reached" state --------------------------------------

export function createPending(res, licenseKey, instanceName, licenseKeyId) {
  const token = randomToken();
  store.putPending(hashToken(token), {
    keyEnc: encrypt(licenseKey),
    keyHash: hashKey(licenseKey),
    licenseKeyId,
    instanceName,
    expiresAt: Date.now() + config.policy.pendingMs,
  });
  res.cookie(PENDING_COOKIE, token, cookieOptions(config.policy.pendingMs));
}

export function readPending(req) {
  const token = req.cookies?.[PENDING_COOKIE];
  if (!token) return null;
  const p = store.getPending(hashToken(token));
  if (!p || p.expiresAt <= Date.now()) return null;
  return { ...p, licenseKey: decrypt(p.keyEnc), token };
}

export function clearPending(req, res) {
  const token = req.cookies?.[PENDING_COOKIE];
  if (token) store.deletePending(hashToken(token));
  res.clearCookie(PENDING_COOKIE, cookieOptions());
}

// --- authentication + re-validation ----------------------------------------------

const inflight = new Map();

/**
 * Resolve the request's session. Re-validates with Lemon Squeezy when the last check
 * is older than REVALIDATE_DAYS (7 by default) and refuses disabled/expired/refunded keys.
 * Returns { ok: true, session, sidHash } or { ok: false, status, code, message }.
 */
export async function authenticate(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return fail(401, "no_session", "Please sign in with your license key.");

  const sidHash = hashToken(sid);
  const session = store.getSession(sidHash);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) store.deleteSession(sidHash);
    return fail(401, "session_expired", "Your session has expired. Please sign in again.");
  }

  if (store.isRevoked(session)) {
    store.deleteSession(sidHash);
    return fail(403, "revoked", "Access to this report has been removed for this license key.");
  }

  if (Date.now() - session.lastValidatedAt > config.policy.revalidateMs) {
    const result = await revalidateOnce(sidHash);
    if (!result.ok) return result;
  }

  return { ok: true, session: store.getSession(sidHash), sidHash };
}

function revalidateOnce(sidHash) {
  if (!inflight.has(sidHash)) {
    inflight.set(
      sidHash,
      revalidate(sidHash).finally(() => inflight.delete(sidHash))
    );
  }
  return inflight.get(sidHash);
}

/** Ask Lemon Squeezy whether this session's key + device are still good. */
export async function revalidate(sidHash) {
  const session = store.getSession(sidHash);
  if (!session) return fail(401, "session_expired", "Please sign in again.");
  const licenseKey = decrypt(session.keyEnc);

  let res;
  try {
    res = await lemon.validate(licenseKey, session.instanceId);
  } catch (err) {
    if (!(err instanceof lemon.LemonUnavailableError)) throw err;
    // Can't reach Lemon Squeezy: keep serving only within the grace window.
    const overdueBy = Date.now() - session.lastValidatedAt - config.policy.revalidateMs;
    if (overdueBy <= config.policy.revalidateGraceMs) return { ok: true, grace: true };
    return fail(503, "validation_unavailable", "We couldn't verify your license right now. Please try again shortly.");
  }

  // Device was removed (by the owner or by support): this browser no longer holds an activation.
  if (res.httpStatus === 404 && /instance/i.test(String(res.error || ""))) {
    return drop(sidHash, 401, "device_removed", "This device was removed from your license key. Please sign in again.");
  }

  const eligible = lemon.checkEligibility(res);
  if (!eligible.ok) return drop(sidHash, 403, eligible.code, eligible.message);
  if (!res.success) return drop(sidHash, 403, "invalid_key", lemon.eligibilityMessages.invalid_key);

  // Refund check (when an API key is configured). Webhooks cover this instantly too.
  let order = null;
  try {
    order = await lemon.getOrder(eligible.meta.order_id);
  } catch {
    /* validate succeeded; a transient order lookup failure shouldn't lock anyone out */
  }
  if (order?.refunded) {
    store.revokeOrder(eligible.meta.order_id);
    return drop(sidHash, 403, "refunded", lemon.eligibilityMessages.refunded);
  }

  store.updateSession(sidHash, {
    lastValidatedAt: Date.now(),
    ...identityFrom(eligible.meta, order || { orderNumber: session.orderNumber }),
  });
  return { ok: true };
}

function drop(sidHash, status, code, message) {
  store.deleteSession(sidHash);
  return fail(status, code, message);
}

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

/** Express middleware for JSON API routes. */
export async function requireSession(req, res, next) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) res.clearCookie(SESSION_COOKIE, cookieOptions());
    return res.status(auth.status).json({ error: auth.code, message: auth.message });
  }
  req.session = auth.session;
  req.sidHash = auth.sidHash;
  next();
}

/**
 * Background sweep: re-check sessions that are due even if the reader isn't open, so
 * disabled/refunded keys are purged on schedule. Not used on serverless platforms.
 */
export function startRevalidationSweep(intervalMs = 60 * 60 * 1000) {
  const run = async () => {
    store.cleanup();
    for (const [sidHash, s] of store.allSessions()) {
      if (Date.now() - s.lastValidatedAt > config.policy.revalidateMs) {
        try {
          await revalidateOnce(sidHash);
        } catch (err) {
          console.warn("[sweep] revalidation failed:", err.message);
        }
      }
    }
  };
  const t = setInterval(run, intervalMs);
  t.unref();
  return run;
}
