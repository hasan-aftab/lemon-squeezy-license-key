import { config } from "./config.js";

/**
 * Lemon Squeezy client. Everything here runs on the server only; the browser never
 * talks to Lemon Squeezy and never sees the API key.
 *
 *  - License API (public, keyed by the license key): activate / validate / deactivate
 *  - Management API (Bearer API key): list a key's devices, look up the order
 */

const L = config.lemon;

/** Thrown when Lemon Squeezy can't be reached or answers with a server error. */
export class LemonUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "LemonUnavailableError";
    this.cause = cause;
  }
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(L.timeoutMs) });
  } catch (err) {
    throw new LemonUnavailableError("Could not reach Lemon Squeezy", err);
  }
  if (res.status >= 500 || res.status === 429) {
    throw new LemonUnavailableError(`Lemon Squeezy returned HTTP ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new LemonUnavailableError("Lemon Squeezy returned a non-JSON response", err);
  }
  return { status: res.status, data };
}

function licensePost(endpoint, params) {
  return request(`${L.licenseBase}/v1/licenses/${endpoint}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

function managementGet(pathAndQuery) {
  return request(`${L.licenseBase}${pathAndQuery}`, {
    method: "GET",
    headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${L.apiKey}` },
  });
}

// --- License API ---------------------------------------------------------------

export async function activate(licenseKey, instanceName) {
  const { status, data } = await licensePost("activate", { license_key: licenseKey, instance_name: instanceName });
  return { httpStatus: status, ...data, success: data.activated === true };
}

export async function validate(licenseKey, instanceId) {
  const params = { license_key: licenseKey };
  if (instanceId) params.instance_id = instanceId;
  const { status, data } = await licensePost("validate", params);
  return { httpStatus: status, ...data, success: data.valid === true };
}

export async function deactivate(licenseKey, instanceId) {
  const { status, data } = await licensePost("deactivate", { license_key: licenseKey, instance_id: instanceId });
  return { httpStatus: status, ...data, success: data.deactivated === true };
}

// --- Management API (needs LEMON_SQUEEZY_API_KEY) --------------------------------

export const hasApiKey = () => Boolean(L.apiKey);

/** Devices activated on a license key, straight from Lemon Squeezy. */
export async function listInstances(licenseKeyId) {
  if (!hasApiKey() || licenseKeyId == null) return null;
  const { status, data } = await managementGet(
    `/v1/license-key-instances?filter[license_key_id]=${encodeURIComponent(licenseKeyId)}&page[size]=100`
  );
  if (status !== 200 || !Array.isArray(data.data)) return null;
  return data.data.map((i) => ({
    id: i.attributes.identifier, // this is the instance_id the License API expects
    name: i.attributes.name,
    createdAt: i.attributes.created_at,
  }));
}

/** Human order number and refund state. Returns null when unavailable. */
export async function getOrder(orderId) {
  if (!hasApiKey() || orderId == null) return null;
  const { status, data } = await managementGet(`/v1/orders/${encodeURIComponent(orderId)}`);
  if (status !== 200 || !data.data) return null;
  const a = data.data.attributes || {};
  return {
    orderNumber: a.order_number ?? null,
    refunded: a.refunded === true || a.status === "refunded" || Boolean(a.refunded_at),
    status: a.status,
  };
}

// --- Eligibility ---------------------------------------------------------------

const MESSAGES = {
  invalid_key: "That license key wasn't recognised. Check it and try again.",
  wrong_product: "That license key isn't for this report.",
  disabled: "This license key has been disabled (for example after a refund). Please contact support.",
  expired: "This license key has expired.",
  refunded: "This order was refunded, so access has been removed.",
  test_key: "That license key isn't valid for this report.",
};

/**
 * Decide whether a Lemon Squeezy response describes a key we should honour:
 * our store/product/variant, not disabled/expired, not a stray test-mode key.
 * Works on activate, validate and deactivate payloads alike.
 */
export function checkEligibility(res, now = Date.now()) {
  const license = res?.license_key;
  const meta = res?.meta;
  if (!license || !meta) return deny("invalid_key");

  if (
    String(meta.store_id) !== L.storeId ||
    String(meta.product_id) !== L.productId ||
    !L.variantIds.includes(String(meta.variant_id))
  ) {
    return deny("wrong_product");
  }

  if (license.status === "disabled") return deny("disabled");
  if (license.status === "expired") return deny("expired");
  if (license.expires_at && new Date(license.expires_at).getTime() <= now) return deny("expired");
  if (license.test_mode && !L.allowTestMode) return deny("test_key");

  return { ok: true, license, meta };
}

function deny(code) {
  return { ok: false, code, message: MESSAGES[code] };
}

/** True when an activate response failed because the device limit is reached. */
export function isDeviceLimitError(res) {
  if (res?.success) return false;
  if (/activation limit/i.test(String(res?.error || ""))) return true;
  const lk = res?.license_key;
  return Boolean(lk && Number(lk.activation_limit) > 0 && Number(lk.activation_usage) >= Number(lk.activation_limit));
}

export { MESSAGES as eligibilityMessages };
