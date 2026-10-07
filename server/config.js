import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

const env = process.env;
const isProd = env.NODE_ENV === "production";

const int = (v, d) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const bool = (v, d = false) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const mockLemon = bool(env.MOCK_LEMON);
const port = int(env.PORT, 3000);

// Variant IDs: VARIANT_IDS=1,2 (VARIANT_ID=1 also accepted for a single tier).
const variantIds = list(env.VARIANT_IDS || env.VARIANT_ID);

export const config = {
  isProd,
  port,
  publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
  trustProxy: env.TRUST_PROXY === undefined ? (isProd ? 1 : 0) : int(env.TRUST_PROXY, 0),
  sessionSecret: env.SESSION_SECRET || "",

  mockLemon,
  lemon: {
    // The public License API (activate/validate/deactivate) needs no key; the
    // management API (list devices, order lookup) needs the API key.
    licenseBase: mockLemon
      ? `http://127.0.0.1:${port}/__mock`
      : env.LEMON_API_BASE || "https://api.lemonsqueezy.com",
    apiKey: env.LEMON_SQUEEZY_API_KEY || "",
    webhookSecret: env.LEMON_WEBHOOK_SECRET || "",
    storeId: String(env.STORE_ID || ""),
    productId: String(env.PRODUCT_ID || ""),
    variantIds,
    allowTestMode: bool(env.ALLOW_TEST_MODE_KEYS, !isProd),
    timeoutMs: 10_000,
  },

  report: {
    title: env.REPORT_TITLE || "Confidential Report",
    pdfPath: path.resolve(ROOT, env.REPORT_PDF_PATH || "storage/report.pdf"),
    renderWidth: Math.min(Math.max(int(env.RENDER_WIDTH, 1200), 600), 2400),
    supportEmail: env.SUPPORT_EMAIL || "",
  },

  policy: {
    sessionMs: int(env.SESSION_DAYS, 30) * DAY,
    revalidateMs: int(env.REVALIDATE_DAYS, 7) * DAY,
    revalidateGraceMs: int(env.REVALIDATE_GRACE_HOURS, 24) * HOUR,
    maxRemovals: int(env.MAX_REMOVALS, 2),
    removalWindowMs: int(env.REMOVAL_WINDOW_DAYS, 30) * DAY,
    pendingMs: 15 * 60 * 1000, // how long the "device limit reached" screen stays actionable
  },

  paths: {
    data: path.resolve(ROOT, env.DATA_DIR || "data"),
    public: path.resolve(ROOT, "public"),
    fonts: path.resolve(ROOT, "node_modules/dejavu-fonts-ttf/ttf"),
  },
};

/** Fail fast on unsafe or incomplete configuration. */
export function assertConfig() {
  const problems = [];

  if (mockLemon && isProd) {
    problems.push("MOCK_LEMON must never be enabled when NODE_ENV=production.");
  }
  if (isProd && config.sessionSecret.length < 32) {
    problems.push("SESSION_SECRET must be set to 32+ random characters in production (openssl rand -hex 32).");
  }
  if (!mockLemon) {
    if (!config.lemon.storeId) problems.push("STORE_ID is required.");
    if (!config.lemon.productId) problems.push("PRODUCT_ID is required.");
    if (config.lemon.variantIds.length === 0) problems.push("VARIANT_IDS (or VARIANT_ID) is required.");
  }

  if (problems.length) {
    throw new Error("Configuration error:\n - " + problems.join("\n - "));
  }

  if (!config.sessionSecret) {
    config.sessionSecret = "dev-only-secret-change-me-dev-only-secret";
    console.warn("[config] SESSION_SECRET not set - using an insecure development default.");
  }
  if (!config.lemon.apiKey && !mockLemon) {
    console.warn(
      "[config] LEMON_SQUEEZY_API_KEY not set - device lists will only show devices registered through this app, " +
        "and refund checks rely on license status/webhooks."
    );
  }
  if (!config.lemon.webhookSecret && !mockLemon) {
    console.warn("[config] LEMON_WEBHOOK_SECRET not set - refunds/disabled keys take effect at the next re-validation, not instantly.");
  }
}
