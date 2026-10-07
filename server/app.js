import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { config } from "./config.js";
import { authenticate, SESSION_COOKIE, cookieOptions } from "./auth.js";
import { createApiRouter, createWebhookHandler } from "./routes.js";
import { createMockLemonRouter, mockEnabled } from "./mock-lemon.js";
import { ROOT } from "./config.js";

const VIEWS = path.join(ROOT, "views");

/** Builds the Express app. index.js listens on a port; serverless.js wraps it for Netlify/Vercel. */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
      strictTransportSecurity: config.isProd,
      referrerPolicy: { policy: "no-referrer" },
    })
  );

  // Local-only stand-in for Lemon Squeezy (never in production).
  if (mockEnabled()) {
    app.use("/__mock", createMockLemonRouter());
    console.warn("[mock] Using the built-in mock Lemon Squeezy API at /__mock (development only).");
  }

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Webhook needs the raw body for signature verification, so it is mounted before express.json().
  app.post("/api/webhooks/lemonsqueezy", express.raw({ type: "*/*", limit: "1mb" }), createWebhookHandler());

  app.use(cookieParser());
  app.use("/api", express.json({ limit: "20kb" }), sameOriginJson, createApiRouter());
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  // Static assets only (css/js). The HTML views are served by the routes below.
  app.use(express.static(config.paths.public, { index: false, maxAge: config.isProd ? "1h" : 0 }));

  // Sign-in page. Already signed in? Go straight to the report.
  app.get("/", async (req, res) => {
    const auth = await authenticate(req);
    if (auth.ok) return res.redirect(302, "/read");
    if (req.cookies?.[SESSION_COOKIE]) res.clearCookie(SESSION_COOKIE, cookieOptions());
    sendView(res, "index.html");
  });

  // The reader. No valid session -> back to sign-in.
  app.get("/read", async (req, res) => {
    const auth = await authenticate(req);
    if (!auth.ok) return res.redirect(302, `/?reason=${encodeURIComponent(auth.code)}`);
    sendView(res, "reader.html");
  });

  app.use((_req, res) => res.status(404).type("text").send("Not found"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("[error]", req.method, req.path, err);
    if (req.path.startsWith("/api")) {
      return res.status(status).json({ error: status === 404 ? "not_found" : "server_error", message: status >= 500 ? "Something went wrong. Please try again." : err.message });
    }
    res.status(status).type("text").send(status >= 500 ? "Something went wrong." : err.message);
  });

  return app;
}

function sendView(res, file) {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.sendFile(path.join(VIEWS, file));
}

/**
 * CSRF guard for state-changing API calls: JSON bodies only (a cross-site form can't
 * send those without a CORS preflight, which we never allow), and if the browser sent an
 * Origin header it must be our own site.
 */
function sameOriginJson(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  if (!req.is("application/json")) {
    return res.status(415).json({ error: "unsupported_media_type", message: "Expected application/json." });
  }
  const origin = req.get("origin");
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = config.publicUrl ? o.origin === new URL(config.publicUrl).origin : o.host === req.get("host");
    } catch {
      ok = false;
    }
    if (!ok) return res.status(403).json({ error: "bad_origin", message: "Cross-site requests are not allowed." });
  }
  next();
}
