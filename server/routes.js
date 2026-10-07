import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import * as store from "./store.js";
import * as lemon from "./lemon.js";
import * as pages from "./pages.js";
import {
  DEVICE_COOKIE,
  authenticate,
  clearPending,
  clearSession,
  createPending,
  createSession,
  ensureDeviceId,
  readPending,
  requireSession,
} from "./auth.js";
import { decrypt, hashKey, hmacHex, safeEqualHex } from "./crypto.js";

export function createApiRouter() {
  const api = express.Router();

  // Slow down key guessing and scripted abuse.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." },
  });

  // Per-session cap on page fetches (an extra brake on bulk scraping).
  const pageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.sidHash,
    message: { error: "rate_limited", message: "You're going through pages very quickly. Please slow down." },
  });

  // ---- public -------------------------------------------------------------------
  api.get("/config", (_req, res) => {
    res.json({ title: config.report.title, supportEmail: config.report.supportEmail });
  });

  // ---- step 1: is this a key we accept? -------------------------------------------
  api.post("/license/check", authLimiter, async (req, res) => {
    const key = normalizeKey(req.body?.license_key);
    if (!key) return bad(res, 400, "invalid_key", lemon.eligibilityMessages.invalid_key);

    const result = await safeLemon(res, () => lemon.validate(key));
    if (!result) return;
    const eligible = lemon.checkEligibility(result);
    if (!eligible.ok) return bad(res, eligible.code === "wrong_product" || eligible.code === "invalid_key" ? 400 : 403, eligible.code, eligible.message);
    if (!result.success) return bad(res, 400, "invalid_key", lemon.eligibilityMessages.invalid_key);
    const revoked = revokedDenial(hashKey(key), eligible.meta);
    if (revoked) return bad(res, 403, revoked.code, revoked.message);

    // Does this browser already hold an activation for this key? Then no device name is needed.
    const deviceId = req.cookies?.[DEVICE_COOKIE];
    const known = Boolean(deviceId && store.getDeviceCookie(hashKey(key), deviceId));
    res.json({ ok: true, knownDevice: known });
  });

  // ---- step 2: activate this device and open a session ------------------------------
  api.post("/activate", authLimiter, async (req, res) => {
    const pending = readPending(req);
    const key = normalizeKey(req.body?.license_key) || pending?.licenseKey;
    if (!key) return bad(res, 400, "invalid_key", lemon.eligibilityMessages.invalid_key);

    const keyHash = hashKey(key);
    const deviceId = ensureDeviceId(req, res);

    // Returning browser: reuse its existing activation instead of consuming a new one.
    const known = store.getDeviceCookie(keyHash, deviceId);
    if (known) {
      const check = await safeLemon(res, () => lemon.validate(key, known.instanceId));
      if (!check) return;
      const eligible = lemon.checkEligibility(check);
      if (!eligible.ok) return bad(res, 403, eligible.code, eligible.message);
      const revoked = revokedDenial(keyHash, eligible.meta);
      if (revoked) return bad(res, 403, revoked.code, revoked.message);
      if (check.success) {
        const order = await safeOrder(eligible.meta.order_id);
        createSession(res, { licenseKey: key, instanceId: known.instanceId, instanceName: known.name, license: eligible.license, meta: eligible.meta, order });
        clearPending(req, res);
        return res.json({ ok: true, reused: true });
      }
      store.forgetInstance(keyHash, known.instanceId); // that activation was removed; fall through to a fresh one
    }

    const name = cleanName(req.body?.instance_name) || cleanName(pending?.instanceName);
    if (!name) return bad(res, 400, "name_required", "Please give this device a name.");

    // Vet the key (our product, not disabled, not refunded) BEFORE consuming an activation slot.
    const pre = await safeLemon(res, () => lemon.validate(key));
    if (!pre) return;
    const preCheck = lemon.checkEligibility(pre);
    if (!preCheck.ok) return bad(res, preCheck.code === "wrong_product" || preCheck.code === "invalid_key" ? 400 : 403, preCheck.code, preCheck.message);
    const preRevoked = revokedDenial(keyHash, preCheck.meta);
    if (preRevoked) return bad(res, 403, preRevoked.code, preRevoked.message);

    const result = await safeLemon(res, () => lemon.activate(key, name));
    if (!result) return;

    // Check store/product/variant and key status BEFORE anything else, including before
    // revealing a device list, so keys from other products learn nothing.
    const eligible = lemon.checkEligibility(result);
    if (!eligible.ok) return bad(res, eligible.code === "wrong_product" || eligible.code === "invalid_key" ? 400 : 403, eligible.code, eligible.message);

    if (result.success) {
      const instance = result.instance;
      store.putDeviceCookie(keyHash, deviceId, { instanceId: instance.id, name, at: Date.now() });
      store.registerInstance(keyHash, instance.id, name);
      const order = await safeOrder(eligible.meta.order_id);
      createSession(res, { licenseKey: key, instanceId: instance.id, instanceName: name, license: eligible.license, meta: eligible.meta, order });
      clearPending(req, res);
      return res.json({ ok: true });
    }

    if (lemon.isDeviceLimitError(result)) {
      createPending(res, key, name, eligible.license.id);
      const devices = await deviceList(keyHash, eligible.license.id);
      return res.status(409).json({
        error: "device_limit",
        message: "This license key is already active on the maximum number of devices.",
        limit: eligible.license.activation_limit,
        ...removalInfo(keyHash),
        devices,
      });
    }

    return bad(res, 400, "activation_failed", String(result.error || "This device couldn't be activated."));
  });

  // ---- device management (from the device-limit screen or from inside the reader) ----
  api.get("/devices", async (req, res) => {
    const ctx = await deviceContext(req);
    if (!ctx) return bad(res, 401, "no_session", "Please sign in with your license key.");
    res.json({ devices: await deviceList(ctx.keyHash, ctx.licenseKeyId, ctx.instanceId), ...removalInfo(ctx.keyHash) });
  });

  api.post("/deactivate", authLimiter, async (req, res) => {
    const ctx = await deviceContext(req);
    if (!ctx) return bad(res, 401, "no_session", "Please sign in with your license key.");

    const instanceId = String(req.body?.instance_id ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instanceId)) return bad(res, 400, "invalid_device", "That device wasn't found.");

    // Only devices that actually belong to this key can be removed.
    const before = await deviceList(ctx.keyHash, ctx.licenseKeyId, ctx.instanceId);
    if (!before.some((d) => d.id === instanceId)) return bad(res, 404, "invalid_device", "That device wasn't found on this license key.");

    // Claim a removal slot first (atomic), so concurrent requests can't exceed the quota.
    const claim = store.reserveRemoval(ctx.keyHash);
    if (!claim) {
      return res.status(429).json({
        error: "removal_limit",
        message: `You've used all ${config.policy.maxRemovals} device removals allowed per ${days(config.policy.removalWindowMs)} days for this key. Please contact support.`,
        supportEmail: config.report.supportEmail,
        ...removalInfo(ctx.keyHash),
      });
    }

    let result;
    try {
      result = await lemon.deactivate(ctx.licenseKey, instanceId);
    } catch (err) {
      store.releaseRemoval(ctx.keyHash, claim);
      if (err instanceof lemon.LemonUnavailableError) return bad(res, 503, "lemon_unavailable", "We couldn't reach the licensing service. Please try again.");
      throw err;
    }
    if (!result.success) {
      store.releaseRemoval(ctx.keyHash, claim);
      return bad(res, 400, "deactivate_failed", String(result.error || "That device couldn't be removed."));
    }

    store.forgetInstance(ctx.keyHash, instanceId);
    store.deleteSessionsWhere((s) => s.keyHash === ctx.keyHash && s.instanceId === instanceId);
    res.json({ ok: true, devices: await deviceList(ctx.keyHash, ctx.licenseKeyId, ctx.instanceId), ...removalInfo(ctx.keyHash) });
  });

  api.post("/logout", (req, res) => {
    clearSession(req, res);
    res.json({ ok: true });
  });

  // ---- the reader (signed-in only) -------------------------------------------------------
  api.get("/me", requireSession, (req, res) => {
    const s = req.session;
    res.json({
      title: config.report.title,
      name: s.customerName,
      email: s.customerEmail,
      orderNumber: s.orderNumber,
      deviceName: s.instanceName,
      pages: pages.pageCount(),
      sessionExpiresAt: s.expiresAt,
    });
  });

  api.get("/pages/:n", requireSession, pageLimiter, async (req, res) => {
    // Block direct navigation to the image URL and cross-site embedding.
    const dest = req.get("sec-fetch-dest");
    const site = req.get("sec-fetch-site");
    if (dest === "document" || dest === "iframe" || dest === "embed" || dest === "object" || site === "cross-site") {
      return bad(res, 403, "forbidden", "Pages can only be viewed inside the reader.");
    }

    const n = Number.parseInt(req.params.n, 10);
    const s = req.session;
    const jpeg = await pages.renderWatermarkedPage(n, {
      customerName: s.customerName,
      customerEmail: s.customerEmail,
      orderNumber: s.orderNumber,
      deviceLabel: s.instanceName,
      ref: req.sidHash.slice(0, 8).toUpperCase(),
    });

    res
      .set({
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.length),
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        "Cross-Origin-Resource-Policy": "same-origin",
      })
      .send(jpeg);
  });

  return api;
}

// ---- Lemon Squeezy webhooks (raw body: the signature covers the exact bytes) ----------------
export function createWebhookHandler() {
  return (req, res) => {
    const secret = config.lemon.webhookSecret;
    if (!secret) return res.status(404).end();

    const raw = req.body; // Buffer, via express.raw()
    const sig = req.get("x-signature") || "";
    if (!Buffer.isBuffer(raw) || !safeEqualHex(sig, hmacHex(secret, raw))) {
      return res.status(401).json({ error: "bad_signature" });
    }

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "bad_json" });
    }

    const name = event?.meta?.event_name || req.get("x-event-name");
    const data = event?.data;
    const attrs = data?.attributes || {};

    if ((name === "license_key_created" || name === "license_key_updated") && attrs.key) {
      const keyHash = hashKey(attrs.key);
      const dead = attrs.status === "disabled" || attrs.status === "expired" || (attrs.expires_at && new Date(attrs.expires_at).getTime() <= Date.now());
      if (dead) {
        store.revokeKey(keyHash);
        store.deleteSessionsWhere((s) => s.keyHash === keyHash);
      } else {
        store.unrevokeKey(keyHash);
      }
    } else if (name === "order_refunded" && data?.id != null) {
      store.revokeOrder(data.id);
      store.deleteSessionsWhere((s) => String(s.orderId) === String(data.id));
    }

    res.json({ ok: true });
  };
}

// ---- helpers --------------------------------------------------------------------------------

const normalizeKey = (k) => {
  const s = String(k ?? "").trim();
  return s.length >= 8 && s.length <= 100 && /^[\w\- ]+$/.test(s) ? s : "";
};

const cleanName = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

const days = (ms) => Math.round(ms / 86_400_000);

/** Keys/orders revoked via webhook (refund, disabled) can't sign in even if Lemon Squeezy hasn't caught up. */
function revokedDenial(keyHash, meta) {
  if (!store.isRevoked({ keyHash, orderId: meta.order_id })) return null;
  return { code: "refunded", message: lemon.eligibilityMessages.refunded };
}

function bad(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

/** Run a Lemon Squeezy call; on outage answer 503 and return null. */
async function safeLemon(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof lemon.LemonUnavailableError) {
      bad(res, 503, "lemon_unavailable", "We couldn't reach the licensing service. Please try again in a moment.");
      return null;
    }
    throw err;
  }
}

async function safeOrder(orderId) {
  try {
    return await lemon.getOrder(orderId);
  } catch {
    return null;
  }
}

function removalInfo(keyHash) {
  return {
    removalsLeft: store.removalsLeft(keyHash),
    maxRemovals: config.policy.maxRemovals,
    windowDays: days(config.policy.removalWindowMs),
    supportEmail: config.report.supportEmail,
  };
}

/** Devices on a key: Lemon Squeezy's own list when we have an API key, else what we registered. */
async function deviceList(keyHash, licenseKeyId, currentInstanceId) {
  let list = null;
  try {
    list = await lemon.listInstances(licenseKeyId);
  } catch {
    /* fall back below */
  }
  if (!list) {
    list = store.registeredInstances(keyHash).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt }));
  }
  return list.map((d) => ({ ...d, current: d.id === currentInstanceId }));
}

/** Who is managing devices: a signed-in session, or someone on the device-limit screen. */
async function deviceContext(req) {
  const auth = await authenticate(req);
  if (auth.ok) {
    return { licenseKey: decrypt(auth.session.keyEnc), keyHash: auth.session.keyHash, licenseKeyId: auth.session.licenseKeyId, instanceId: auth.session.instanceId };
  }
  const p = readPending(req);
  if (p) return { licenseKey: p.licenseKey, keyHash: p.keyHash, licenseKeyId: p.licenseKeyId, instanceId: null };
  return null;
}
