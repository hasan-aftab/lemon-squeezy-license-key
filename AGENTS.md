# AGENTS.md

Secure Report Viewer: single-package Node 20.6+ / Express 5 app, ESM only (`"type": "module"`), vanilla JS front end, **no build step**. Full docs in `README.md`; this file covers what's easy to get wrong.

## Commands

```bash
npm run dev:mock     # primary dev command: server on :3000 with mock Lemon Squeezy
npm test             # E2E smoke test (scripts/smoke-test.js) — the only test
npm run sample-pdf   # optional: writes storage/report.pdf (6-page demo)
```

- `npm run dev` / `npm start` need a real `.env` with `STORE_ID`, `PRODUCT_ID`, `VARIANT_IDS` or `assertConfig()` throws at startup (server/config.js:78). Use `dev:mock` instead; `.env.mock` supplies everything.
- `npm test` is a **single monolithic script**, not a framework — no way to run one test. It boots its own server on port **3911** (`TEST_PORT` overrides) with a throwaway temp `DATA_DIR`, so it never touches your `data/`. Mock mode only.
- If `storage/report.pdf` is missing the app serves 6 generated placeholder pages instead of failing.
- **No lint, typecheck, formatter, or CI exists.** Don't invent a command; `node --check <file>` is the only static check.

## Architecture (not obvious from filenames)

- `server/app.js` exports `createApp()`; `server/index.js` is the long-running entry (+ hourly re-validation sweep), `server/serverless.js` is the same app for Netlify (untested path — see README trade-offs). Tests import `createApp()` directly.
- `server/store.js` is the intentional swap boundary (JSON file → Redis/SQL for multi-instance/serverless). Other modules use only its exported functions. It loads state into module memory **once at import** — mutating `data/store.json` on disk while a process runs has no effect.
- `server/config.js` reads env once at import via `dotenv/config`. Node's `--env-file=.env.mock` is applied before dotenv, so `.env.mock` keys win over `.env`.
- `server/mock-lemon.js` mounts at `/__mock` only when `MOCK_LEMON=true` and refuses to run when `NODE_ENV=production` — keep both invariants.
- `server/pages.js` renders pages with mupdf + sharp **per request** (watermark varies per buyer); fonts come from `dejavu-fonts-ttf` in node_modules so output is host-independent.

## Repo-specific conventions

- **CSP forbids all inline script and style** (helmet, server/app.js:19). New client behavior goes in `public/js/*.js` / `public/css/app.css` — inline handlers/snippets are silently blocked in the browser.
- POSTs to `/api/*` are **JSON-only** with an Origin check (server/app.js:99): form-encoded → 415, cross-site Origin → 403. The smoke test asserts this; don't relax it.
- Page/image responses are `no-store`; page URLs refuse direct navigation and cross-site embedding (`Sec-Fetch-*` checks). Tests cover these — a change that breaks them will show up in `npm test`.
- Git-ignored and never served: `.env`, `data/`, `storage/*.pdf`. The PDF must stay outside `public/`; tests assert `/storage/report.pdf`, `/data/store.json`, `/.env.mock` all 404.
- `data/store.json` holds sessions, device registry, and removal quotas. Deleting it signs everyone out and resets the 2-per-30-days removal counters.
- Removal quota is claimed **before** calling Lemon Squeezy and released on failure (server/store.js:116) — preserve that order if touching removal code.
- Lemon Squeezy setup (IDs, webhook, variants = device limits) is documented in README + `.env.example`; don't duplicate it here.
