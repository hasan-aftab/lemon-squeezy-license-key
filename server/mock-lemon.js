import express from "express";
import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * In-process stand-in for the Lemon Squeezy License API + the two management
 * endpoints this app uses, with the same JSON shapes. It lets you run and test the
 * whole flow locally without a store. Mounted at /__mock only when MOCK_LEMON=true
 * (and refused outright when NODE_ENV=production).
 *
 * Demo keys (store 1111, product 2222):
 *   BASIC-1111-AAAA-0001     variant 3333, 1 device
 *   TEAM-2222-BBBB-0002      variant 4444, 3 devices
 *   DISABLED-3333-CCCC-0003  disabled (e.g. refunded)
 *   EXPIRED-4444-DDDD-0004   expired
 *   OTHER-5555-EEEE-0005     a different product (must be rejected)
 */

const MOCK_API_KEY = "mock-api-key";
const now = () => new Date().toISOString();

const orders = new Map();
const keys = new Map();

function seed(key, o) {
  orders.set(o.orderId, { orderNumber: o.orderNumber, refunded: false });
  keys.set(key, {
    id: o.id,
    key,
    status: o.status || "inactive",
    activation_limit: o.limit,
    instances: [],
    created_at: now(),
    expires_at: o.expires_at || null,
    test_mode: false,
    meta: {
      store_id: o.store ?? 1111,
      order_id: o.orderId,
      order_item_id: o.orderId * 10,
      product_id: o.product ?? 2222,
      product_name: "Confidential Market Report",
      variant_id: o.variant,
      variant_name: o.variantName,
      customer_id: o.id * 100,
      customer_name: o.name,
      customer_email: o.email,
    },
  });
}

function reset() {
  orders.clear();
  keys.clear();
  seed("BASIC-1111-AAAA-0001", { id: 1, orderId: 5001, orderNumber: 1042, variant: 3333, variantName: "Solo", limit: 1, name: "Ada Lovelace", email: "ada@example.com" });
  seed("TEAM-2222-BBBB-0002", { id: 2, orderId: 5002, orderNumber: 1043, variant: 4444, variantName: "Team", limit: 3, name: "Grace Hopper", email: "grace@example.com" });
  seed("DISABLED-3333-CCCC-0003", { id: 3, orderId: 5003, orderNumber: 1044, variant: 3333, variantName: "Solo", limit: 1, status: "disabled", name: "Alan Turing", email: "alan@example.com" });
  seed("EXPIRED-4444-DDDD-0004", { id: 4, orderId: 5004, orderNumber: 1045, variant: 4444, variantName: "Team", limit: 3, status: "expired", expires_at: "2024-01-01T00:00:00.000Z", name: "Edsger Dijkstra", email: "edsger@example.com" });
  seed("OTHER-5555-EEEE-0005", { id: 5, orderId: 5005, orderNumber: 1046, variant: 9999, variantName: "Other", product: 7777, limit: 3, name: "Someone Else", email: "else@example.com" });
}
reset();

const licenseView = (k) => ({
  id: k.id,
  status: k.status,
  key: k.key,
  activation_limit: k.activation_limit,
  activation_usage: k.instances.length,
  created_at: k.created_at,
  expires_at: k.expires_at,
  test_mode: k.test_mode,
});

const base = (k) => ({ license_key: k ? licenseView(k) : null, meta: k ? k.meta : null });

export function createMockLemonRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(express.json());

  const find = (b) => keys.get(String(b.license_key || "").trim());
  const notFound = (flag) => ({ [flag]: false, error: "license_key not found.", license_key: null, instance: null, meta: null });

  r.post("/v1/licenses/activate", (req, res) => {
    const k = find(req.body);
    if (!k) return res.status(404).json(notFound("activated"));
    if (k.status === "disabled") return res.status(400).json({ activated: false, error: "This license key is disabled.", ...base(k), instance: null });
    if (k.status === "expired") return res.status(400).json({ activated: false, error: "This license key has expired.", ...base(k), instance: null });
    if (k.instances.length >= k.activation_limit) {
      return res.status(400).json({ activated: false, error: "This license key has reached the activation limit.", ...base(k), instance: null });
    }
    const inst = { id: crypto.randomUUID(), name: String(req.body.instance_name || "Unnamed"), created_at: now() };
    k.instances.push(inst);
    k.status = "active";
    res.json({ activated: true, error: null, ...base(k), instance: inst });
  });

  r.post("/v1/licenses/validate", (req, res) => {
    const k = find(req.body);
    if (!k) return res.status(404).json({ valid: false, error: "license_key not found.", license_key: null, instance: null, meta: null });
    const out = (valid, error, instance = null) => res.json({ valid, error, ...base(k), instance });
    if (k.status === "disabled") return out(false, "license_key is disabled.");
    if (k.status === "expired") return out(false, "license_key is expired.");
    if (req.body.instance_id) {
      const inst = k.instances.find((i) => i.id === req.body.instance_id);
      if (!inst) return res.status(404).json({ valid: false, error: "instance_id not found.", ...base(k), instance: null });
      return out(true, null, inst);
    }
    out(true, null);
  });

  r.post("/v1/licenses/deactivate", (req, res) => {
    const k = find(req.body);
    if (!k) return res.status(404).json(notFound("deactivated"));
    const i = k.instances.findIndex((x) => x.id === req.body.instance_id);
    if (i === -1) return res.status(404).json({ deactivated: false, error: "instance_id not found.", ...base(k) });
    k.instances.splice(i, 1);
    if (k.instances.length === 0 && k.status === "active") k.status = "inactive";
    res.json({ deactivated: true, error: null, ...base(k) });
  });

  // --- Management API (Bearer) ---
  const auth = (req, res, next) =>
    req.get("authorization") === `Bearer ${MOCK_API_KEY}` ? next() : res.status(401).json({ errors: [{ status: "401", title: "Unauthenticated." }] });

  r.get("/v1/license-key-instances", auth, (req, res) => {
    // Express 5 uses the "simple" query parser, so bracketed keys arrive flat.
    const id = String(req.query["filter[license_key_id]"] ?? "");
    const k = [...keys.values()].find((x) => String(x.id) === id);
    const data = (k?.instances || []).map((i, n) => ({
      type: "license-key-instances",
      id: String(n + 1),
      attributes: { license_key_id: k.id, identifier: i.id, name: i.name, created_at: i.created_at },
    }));
    res.json({ data });
  });

  r.get("/v1/orders/:id", auth, (req, res) => {
    const o = orders.get(Number(req.params.id));
    if (!o) return res.status(404).json({ errors: [{ status: "404", title: "Not Found" }] });
    res.json({
      data: {
        type: "orders",
        id: req.params.id,
        attributes: { order_number: o.orderNumber, status: o.refunded ? "refunded" : "paid", refunded: o.refunded, refunded_at: o.refunded ? now() : null },
      },
    });
  });

  // --- Test helpers (development only) ---
  r.post("/admin/license-status", (req, res) => {
    const k = find(req.body);
    if (!k) return res.status(404).json({ ok: false });
    k.status = req.body.status;
    res.json({ ok: true, status: k.status });
  });
  r.post("/admin/refund", (req, res) => {
    const o = orders.get(Number(req.body.order_id));
    if (!o) return res.status(404).json({ ok: false });
    o.refunded = true;
    res.json({ ok: true });
  });
  r.post("/admin/reset", (_req, res) => {
    reset();
    res.json({ ok: true });
  });

  return r;
}

export const mockApiKey = MOCK_API_KEY;
export const mockEnabled = () => config.mockLemon && !config.isProd;
