import crypto from "node:crypto";
import { config } from "./config.js";

let derived;
function keys() {
  if (!derived) {
    const root = crypto.createHash("sha256").update(config.sessionSecret).digest();
    derived = {
      hmac: crypto.createHmac("sha256", root).update("hmac-v1").digest(),
      enc: crypto.createHmac("sha256", root).update("enc-v1").digest(),
    };
  }
  return derived;
}

/** Stable, non-reversible identifier for a license key (used as a store key). */
export function hashKey(licenseKey) {
  return crypto.createHmac("sha256", keys().hmac).update(String(licenseKey).trim()).digest("hex");
}

/** Hash for opaque random tokens (cookie values) before they touch the store. */
export function hashToken(token) {
  return crypto.createHmac("sha256", keys().hmac).update("token:" + token).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** AES-256-GCM, so license keys are not stored in plaintext on disk. */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys().enc, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob) {
  const [iv, tag, ct] = String(blob)
    .split(".")
    .map((p) => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keys().enc, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function hmacHex(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}
