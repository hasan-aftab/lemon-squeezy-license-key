// End-to-end smoke test against the built-in mock Lemon Squeezy API.
// Run with: npm test   (uses .env.mock; writes to a throwaway data directory)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.PORT = process.env.TEST_PORT || "3911";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rv-test-"));
process.env.MOCK_LEMON = "true";

const { config, assertConfig } = await import("../server/config.js");
const { createApp } = await import("../server/app.js");
const store = await import("../server/store.js");

assertConfig();
const server = createApp().listen(config.port);
const BASE = `http://127.0.0.1:${config.port}`;
const DAY = 86_400_000;

// --- tiny harness ----------------------------------------------------------------
let failed = 0;
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
}
const section = (t) => console.log(`\n${t}`);

class Jar {
  constructor() { this.c = new Map(); }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || v === "") this.c.delete(k); else this.c.set(k, v);
    }
  }
}

async function call(jar, method, url, { json, headers = {}, raw, contentType } = {}) {
  const h = { ...headers };
  if (jar?.header()) h.cookie = jar.header();
  let body;
  if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (raw !== undefined) { body = raw; if (contentType) h["content-type"] = contentType; }
  const res = await fetch(BASE + url, { method, headers: h, body, redirect: "manual" });
  jar?.absorb(res);
  const type = res.headers.get("content-type") || "";
  const out = { status: res.status, headers: res.headers, type };
  if (type.includes("json")) out.data = await res.json().catch(() => ({}));
  else out.buf = Buffer.from(await res.arrayBuffer());
  return out;
}

const mock = (p, body) => call(null, "POST", `/__mock${p}`, { raw: new URLSearchParams(body).toString(), contentType: "application/x-www-form-urlencoded" });
const KEYS = { basic: "BASIC-1111-AAAA-0001", team: "TEAM-2222-BBBB-0002", disabled: "DISABLED-3333-CCCC-0003", expired: "EXPIRED-4444-DDDD-0004", other: "OTHER-5555-EEEE-0005" };

async function signIn(jar, key, name) {
  const c = await call(jar, "POST", "/api/license/check", { json: { license_key: key } });
  if (!c.data?.ok) return { step: "check", ...c };
  return { step: "activate", ...(await call(jar, "POST", "/api/activate", { json: { license_key: key, instance_name: name } })) };
}

try {
  await mock("/admin/reset", {});

  section("Access control");
  let r = await call(null, "GET", "/read");
  check("/read without a session redirects to sign-in", r.status === 302 && r.headers.get("location").startsWith("/?reason="));
  r = await call(null, "GET", "/api/pages/1");
  check("page image without a session is refused (401)", r.status === 401);
  for (const p of ["/storage/report.pdf", "/report.pdf", "/data/store.json", "/server/config.js", "/.env.mock", "/package.json"]) {
    r = await call(null, "GET", p);
    check(`${p} is not reachable`, r.status === 404);
  }

  section("Key checks (store / product / variant / status)");
  r = await call(new Jar(), "POST", "/api/license/check", { json: { license_key: KEYS.other } });
  check("key from another product is rejected", r.status === 400 && r.data.error === "wrong_product", JSON.stringify(r.data));
  r = await call(new Jar(), "POST", "/api/license/check", { json: { license_key: "NOT-A-REAL-KEY-12345" } });
  check("unknown key is rejected", r.status === 400 && r.data.error === "invalid_key", JSON.stringify(r.data));
  r = await call(new Jar(), "POST", "/api/license/check", { json: { license_key: KEYS.disabled } });
  check("disabled key is rejected", r.status === 403 && r.data.error === "disabled", JSON.stringify(r.data));
  r = await call(new Jar(), "POST", "/api/license/check", { json: { license_key: KEYS.expired } });
  check("expired key is rejected", r.status === 403 && r.data.error === "expired", JSON.stringify(r.data));
  r = await call(new Jar(), "POST", "/api/activate", { json: { license_key: KEYS.other, instance_name: "x" } });
  check("activating a wrong-product key never opens a session", r.status === 400 && !r.data.ok);

  section("CSRF / request hygiene");
  r = await call(null, "POST", "/api/license/check", { json: { license_key: KEYS.basic }, headers: { origin: "https://evil.example" } });
  check("cross-site Origin is refused", r.status === 403, String(r.status));
  r = await call(null, "POST", "/api/license/check", { raw: `license_key=${KEYS.basic}`, contentType: "application/x-www-form-urlencoded" });
  check("form-encoded POST is refused (JSON only)", r.status === 415, String(r.status));

  section("Sign-in, new device name, reader");
  const jar1 = new Jar();
  let c = await call(jar1, "POST", "/api/license/check", { json: { license_key: KEYS.basic } });
  check("valid key accepted; browser is a new device", c.data.ok && c.data.knownDevice === false, JSON.stringify(c.data));
  r = await call(jar1, "POST", "/api/activate", { json: { license_key: KEYS.basic } });
  check("activating without a device name asks for one", r.status === 400 && r.data.error === "name_required", JSON.stringify(r.data));
  r = await call(jar1, "POST", "/api/activate", { json: { license_key: KEYS.basic, instance_name: "Chrome on Mac" } });
  check("activation with a device name succeeds", r.status === 200 && r.data.ok, JSON.stringify(r.data));
  const cookieHeader = r.headers.getSetCookie().find((l) => l.startsWith("rv_session="));
  check("session cookie is HttpOnly + SameSite=Lax", /HttpOnly/i.test(cookieHeader) && /SameSite=Lax/i.test(cookieHeader), cookieHeader);
  check("session cookie lasts 30 days", /Max-Age=2592000/i.test(cookieHeader), cookieHeader);

  r = await call(jar1, "GET", "/api/me");
  check("/api/me returns licensee, order number and page count", r.status === 200 && r.data.name === "Ada Lovelace" && r.data.orderNumber === "1042" && r.data.pages >= 1, JSON.stringify(r.data));
  r = await call(jar1, "GET", "/");
  check("already-activated device goes straight to the report", r.status === 302 && r.headers.get("location") === "/read");
  r = await call(jar1, "GET", "/read");
  check("/read serves the reader", r.status === 200 && r.type.includes("html"));

  section("Page images (watermarked, never the PDF)");
  r = await call(jar1, "GET", "/api/pages/1");
  check("page 1 is a JPEG", r.status === 200 && r.type === "image/jpeg" && r.buf[0] === 0xff && r.buf[1] === 0xd8, r.type);
  check("response is not a PDF", r.buf.subarray(0, 4).toString() !== "%PDF");
  check("page response is no-store", /no-store/.test(r.headers.get("cache-control") || ""));
  const sample = fs.existsSync(config.report.pdfPath) ? fs.readFileSync(config.report.pdfPath) : null;
  check("page bytes differ from the source PDF", !sample || !r.buf.equals(sample));
  r = await call(jar1, "GET", "/api/pages/9999");
  check("out-of-range page is 404", r.status === 404);
  r = await call(jar1, "GET", "/api/pages/1", { headers: { "sec-fetch-dest": "document" } });
  check("opening an image URL directly (navigation) is refused", r.status === 403);
  r = await call(jar1, "GET", "/api/pages/1", { headers: { "sec-fetch-site": "cross-site" } });
  check("cross-site embedding of page images is refused", r.status === 403);

  // Watermark carries the licensee: different buyers receive different bytes.
  const jarTeam = new Jar();
  await signIn(jarTeam, KEYS.team, "Firefox on Windows");
  const a = await call(jar1, "GET", "/api/pages/2");
  const b = await call(jarTeam, "GET", "/api/pages/2");
  check("two buyers get different bytes for the same page", a.status === 200 && b.status === 200 && !a.buf.equals(b.buf));

  section("Device limit + removal (limit 1, key BASIC)");
  const jar2 = new Jar();
  r = await signIn(jar2, KEYS.basic, "Safari on iPhone");
  check("second device is blocked with the device-limit message", r.status === 409 && r.data.error === "device_limit", JSON.stringify(r.data));
  check("device list is returned", Array.isArray(r.data.devices) && r.data.devices.length === 1 && r.data.devices[0].name === "Chrome on Mac", JSON.stringify(r.data.devices));
  check("removals left = 2 before any removal", r.data.removalsLeft === 2);
  r = await call(jar2, "GET", "/api/me");
  check("blocked device has no reader access", r.status === 401);

  const firstInstance = (await call(jar2, "GET", "/api/devices")).data.devices[0].id;
  r = await call(jar2, "POST", "/api/deactivate", { json: { instance_id: "00000000-0000-0000-0000-000000000000" } });
  check("removing a device that isn't on the key is refused", r.status === 404, JSON.stringify(r.data));
  r = await call(jar2, "POST", "/api/deactivate", { json: { instance_id: firstInstance } });
  check("removal #1 succeeds", r.status === 200 && r.data.ok && r.data.removalsLeft === 1, JSON.stringify(r.data));
  r = await call(jar1, "GET", "/api/me");
  check("removed device is locked out immediately", r.status === 401);
  r = await call(jar2, "POST", "/api/activate", { json: { instance_name: "Safari on iPhone" } });
  check("blocked device can now activate (using its pending state)", r.status === 200 && r.data.ok, JSON.stringify(r.data));
  r = await call(jar2, "GET", "/api/me");
  check("and opens the report", r.status === 200);

  // Second removal, then the quota is exhausted.
  r = await signIn(jar1, KEYS.basic, "Chrome on Mac");
  check("first device is now the blocked one", r.status === 409);
  const secondInstance = r.data.devices[0].id;
  r = await call(jar1, "POST", "/api/deactivate", { json: { instance_id: secondInstance } });
  check("removal #2 succeeds, none left", r.status === 200 && r.data.removalsLeft === 0, JSON.stringify(r.data));
  r = await call(jar1, "POST", "/api/activate", { json: { instance_name: "Chrome on Mac" } });
  check("device re-activates", r.status === 200 && r.data.ok);

  const jar3 = new Jar();
  r = await signIn(jar3, KEYS.basic, "Edge on Windows");
  check("third device blocked again", r.status === 409);
  r = await call(jar3, "POST", "/api/deactivate", { json: { instance_id: r.data.devices[0].id } });
  check("removal #3 within 30 days is refused: contact support", r.status === 429 && r.data.error === "removal_limit" && /contact support/i.test(r.data.message), JSON.stringify(r.data));
  check("support email is provided", r.data.supportEmail === config.report.supportEmail);

  section("Returning browser reuses its activation");
  await call(jar1, "POST", "/api/logout", { json: {} });
  r = await call(jar1, "GET", "/api/me");
  check("signed out", r.status === 401);
  c = await call(jar1, "POST", "/api/license/check", { json: { license_key: KEYS.basic } });
  check("same browser is recognised as a known device", c.data.knownDevice === true, JSON.stringify(c.data));
  r = await call(jar1, "POST", "/api/activate", { json: { license_key: KEYS.basic } });
  check("signs back in without a new name or a new activation", r.status === 200 && r.data.reused === true, JSON.stringify(r.data));
  r = await call(jar1, "GET", "/api/devices");
  check("device count unchanged (still 1)", r.data.devices.length === 1);

  section("Re-validation every 7 days");
  const sessionHash = (key) => store.allSessions().find(([, s]) => s.keyHash && s.customerName === key)?.[0];
  let h = sessionHash("Grace Hopper");
  const before = store.getSession(h).lastValidatedAt;
  store.updateSession(h, { lastValidatedAt: Date.now() - 8 * DAY });
  r = await call(jarTeam, "GET", "/api/me");
  check("8-day-old session is re-validated and kept when the key is still good", r.status === 200 && store.getSession(h).lastValidatedAt > before - 8 * DAY + DAY, String(r.status));

  store.updateSession(h, { lastValidatedAt: Date.now() - 3 * DAY });
  await mock("/admin/license-status", { license_key: KEYS.team, status: "disabled" });
  r = await call(jarTeam, "GET", "/api/me");
  check("within 7 days no re-check happens (still served)", r.status === 200);
  store.updateSession(h, { lastValidatedAt: Date.now() - 8 * DAY });
  r = await call(jarTeam, "GET", "/api/me");
  check("disabled key is refused at the next re-validation", r.status === 403 && r.data.error === "disabled", JSON.stringify(r.data));
  r = await call(jarTeam, "GET", "/api/pages/1");
  check("and its page images stop immediately", r.status === 401 || r.status === 403);

  section("Refund via webhook (instant)");
  const jarRefund = new Jar();
  await mock("/admin/license-status", { license_key: KEYS.team, status: "active" });
  r = await signIn(jarRefund, KEYS.team, "Brave on Linux");
  check("team key signs in again after re-enable", r.status === 200 && r.data?.ok, JSON.stringify(r.data));
  r = await call(jarRefund, "GET", "/api/me");
  check("session is live", r.status === 200);
  const payload = JSON.stringify({ meta: { event_name: "order_refunded" }, data: { type: "orders", id: "5002", attributes: {} } });
  const sig = crypto.createHmac("sha256", process.env.LEMON_WEBHOOK_SECRET).update(payload).digest("hex");
  r = await call(null, "POST", "/api/webhooks/lemonsqueezy", { raw: payload, contentType: "application/json", headers: { "x-signature": "0".repeat(64) } });
  check("webhook with a bad signature is rejected", r.status === 401);
  r = await call(null, "POST", "/api/webhooks/lemonsqueezy", { raw: payload, contentType: "application/json", headers: { "x-signature": sig } });
  check("signed refund webhook accepted", r.status === 200);
  r = await call(jarRefund, "GET", "/api/me");
  check("refunded reader is locked out right away", r.status === 401 || r.status === 403, String(r.status));
  r = await signIn(new Jar(), KEYS.team, "Another device");
  check("refunded order can't sign in again", r.status >= 400 && !r.data?.ok, JSON.stringify(r.data));
} catch (err) {
  failed++;
  console.error("\nUnexpected error:", err);
} finally {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
