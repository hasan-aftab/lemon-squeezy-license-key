# Secure Report Viewer

A small private site where buyers of a paid report enter their **Lemon Squeezy license key** and read the report **page by page in the browser**, limited to the number of devices their tier allows. The PDF is never sent to the browser; readers only ever receive **watermarked page images**, and only inside a signed-in session.

Node.js + Express, vanilla JS front end, no build step.

## What it does

| Requirement | How it is met |
|---|---|
| Sign in with a license key | `/` -> `POST /api/license/check` -> `POST /api/activate` |
| New device is named (prefilled, e.g. "Chrome on Mac") | Name step on the sign-in page; default guessed from the browser |
| Report opens page by page, watermarked with name, email, order number | `/read` + `GET /api/pages/:n` (sharp composites the watermark per request) |
| Known device goes straight in for up to 30 days | HttpOnly session cookie, 30-day lifetime; `/` redirects to `/read` |
| Device limit reached -> clear message, device list, "Remove" | 409 `device_limit` response drives the limit screen |
| Activate each device against Lemon Squeezy, refuse past the variant limit | `POST /v1/licenses/activate`; the limit is the activation limit set on the variant |
| Only our store / product / variant IDs | Checked on every activate, validate and refresh (`STORE_ID`, `PRODUCT_ID`, `VARIANT_IDS`) |
| Re-validate at least every 7 days; refuse disabled / expired / refunded at once | On the next request after 7 days, plus an hourly background sweep, plus webhooks for instant effect |
| Max 2 device removals per key per 30 days, then "contact support" | Atomic quota in the store, claimed *before* calling Lemon Squeezy |
| Never send the original PDF | PDF lives in `storage/` (not under `/public`), rendered server-side; page responses are `no-store` JPEGs |
| Deterrents: right-click, selection, printing | CSS + JS listeners in the reader (a deterrent only; the watermark is the real protection) |
| License API calls stay on the server | The browser only talks to this app's `/api/*` |
| Chrome, Safari, Edge, Firefox; desktop and mobile | Responsive layout, 16px inputs (no iOS zoom), `dvh` units, swipe and keyboard navigation |

## Quick start (no Lemon Squeezy account needed)

```bash
npm install
npm run sample-pdf      # writes storage/report.pdf (6-page demo). Optional: placeholder pages are used if missing
npm run dev:mock        # http://localhost:3000, using a built-in mock of the Lemon Squeezy API
```

Demo keys for the mock (store 1111, product 2222):

| Key | Behaviour |
|---|---|
| `BASIC-1111-AAAA-0001` | Valid, 1 device |
| `TEAM-2222-BBBB-0002` | Valid, 3 devices |
| `DISABLED-3333-CCCC-0003` | Disabled (as after a refund) |
| `EXPIRED-4444-DDDD-0004` | Expired |
| `OTHER-5555-EEEE-0005` | A different product; must be rejected |

Try the device limit by signing in with `BASIC-...` in one browser, then in a second browser or a private window.

```bash
npm test                # 60 end-to-end checks against the mock (activation, limits, removals, re-validation, refunds)
```

The mock refuses to start when `NODE_ENV=production`.

## Using your real Lemon Squeezy store

1. **Variants and license keys.** On each product variant, enable license keys and set the **activation limit** (devices) for that tier. That number is the device limit; this app enforces it through Lemon Squeezy.
2. **IDs.** Find your store, product and variant IDs in the Lemon Squeezy dashboard (or via the API) and put them in `.env`: `STORE_ID`, `PRODUCT_ID`, `VARIANT_IDS` (comma-separated, one per tier).
3. **API key.** Create one under *Settings > API* and set `LEMON_SQUEEZY_API_KEY`. The public License API can activate, validate and deactivate, but **cannot list a key's devices**; the key is needed for the device list and for the human order number / refund lookup. It stays on the server.
4. **Webhook (recommended).** Under *Settings > Webhooks* add `https://YOUR-DOMAIN/api/webhooks/lemonsqueezy`, subscribe to `license_key_created`, `license_key_updated` and `order_refunded`, and put the signing secret in `LEMON_WEBHOOK_SECRET`. Without it, refunds and disabled keys still take effect at the next re-validation (7 days at most), but with it they lock the reader out immediately.
5. **Checkout link.** Point the checkout/receipt "Read your report" button at your site. You can prefill the key with a URL fragment, e.g. `https://YOUR-DOMAIN/#key=THE-KEY` (fragments are never sent to servers or logged); the page scrubs it from the address bar.
6. `cp .env.example .env`, set `SESSION_SECRET` (`openssl rand -hex 32`), put your PDF at `storage/report.pdf` (or set `REPORT_PDF_PATH`), then `npm install && npm start`.

All settings are documented in [`.env.example`](.env.example).

## How it works

```
Browser                         This server                         Lemon Squeezy
  | paste key ------------------> /api/license/check ------------------> validate
  |                                 (store/product/variant/status ok?)
  | device name ----------------> /api/activate ----------------------> activate
  |                                 limit reached? -> 409 + device list <- list instances (API key)
  | <- HttpOnly cookie (30 days)    session stored server-side (key encrypted at rest)
  | GET /read, /api/pages/N -----> check session (re-validate if > 7 days) -> render page,
  |                                 watermark (name, email, order, ref id), send JPEG
```

- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie. The store holds only a hash of the token; the license key is AES-256-GCM encrypted.
- **A returning browser reuses its activation.** A long-lived device cookie maps the browser to its Lemon Squeezy instance, so signing in again after the 30 days (or after signing out) doesn't burn another device slot.
- **Removal quota** is reserved atomically before the Lemon Squeezy call and released if that call fails, so concurrent requests can't exceed 2 per key per 30 days.
- **Watermark.** Each page is composited per request with a repeating diagonal "name · email · Order #" plus a footer carrying the device name, a UTC timestamp and a short reference id that ties a leaked image back to a session. Font files are bundled (`dejavu-fonts-ttf`), so output is identical on every host.
- **Request hygiene.** JSON-only POSTs with an Origin check (CSRF), a strict CSP with no inline script or style, rate limits on sign-in and removal endpoints, a per-session cap on page fetches, and page URLs that refuse direct navigation and cross-site embedding.

## Project layout

```
server/
  index.js        start the server (+ hourly re-validation sweep)
  app.js          Express app: security headers, routes, views
  serverless.js   same app wrapped with serverless-http
  routes.js       /api/* endpoints and the Lemon Squeezy webhook
  auth.js         sessions, re-validation, pending device-limit state
  lemon.js        Lemon Squeezy client + eligibility rules (IDs, status)
  pages.js        PDF -> page images (mupdf) and watermarking (sharp)
  store.js        JSON-file store (swap for Redis/SQL to scale out)
  crypto.js       hashing / AES-GCM helpers
  mock-lemon.js   local mock of the Lemon Squeezy API (dev only)
  config.js       environment + policy settings
views/            index.html (sign-in), reader.html
public/           css/ and js/ (no secrets, no report content)
storage/          report.pdf lives here (git-ignored, never served)
scripts/          make-sample-pdf.js, smoke-test.js
```

## Deploying

The app needs: Node 20.6+, a **persistent disk** for `data/` (sessions, removal counters), and HTTPS.

**Render / Railway / Fly (recommended, free tiers work).** Create a Web Service from the repo: build `npm install`, start `npm start`. Set the environment variables from `.env.example` (`NODE_ENV=production`, `TRUST_PROXY=1`, `PUBLIC_URL=https://...`). Attach a small persistent disk mounted at `/app/data` (or set `DATA_DIR`), otherwise sessions and the removal counters reset on every deploy. Upload the report to `storage/report.pdf` via a disk, a build step that fetches it from private storage, or `REPORT_PDF_PATH`. Free instances that sleep will make the first request slow; sessions survive if the disk does.

**VPS.** `npm ci --omit=dev`, run with `pm2 start server/index.js --name report-viewer` (or a systemd unit), and put nginx or Caddy in front for HTTPS with `TRUST_PROXY=1`. Keep `.env` readable only by the service user.

**Netlify / Vercel (serverless).** `server/serverless.js` exports a `handler` wrapped with `serverless-http`, and `netlify.toml` + `netlify/functions/app.mjs` are included. Be aware of the trade-offs before choosing this:
- Functions have **no persistent disk**, so the JSON store would reset between invocations. Replace `server/store.js` with a hosted store (Redis/Upstash, Postgres, Netlify Blobs); every other module only uses the functions it exports.
- The background re-validation sweep doesn't run; re-validation still happens on request after 7 days.
- `sharp` and `mupdf` are large native/WASM dependencies and the render takes a few hundred ms per page, so mind bundle-size and timeout limits.
- This path was **not** tested end to end; Render/Railway/VPS is the safer route.

## Limits worth knowing

- **Screenshots and photos of the screen can't be prevented in a browser.** The deterrents (no right-click, selection, copy or print; images behind a transparent shield) only stop casual copying. The per-buyer watermark, which includes a trace reference, is the real protection, and a shared key is capped by the device limit.
- The JSON store suits **one server process**. For several instances, swap in a shared store.
- If Lemon Squeezy is unreachable when a re-check is due, readers keep access for `REVALIDATE_GRACE_HOURS` (default 24) and are then locked out until it responds.
- Lemon Squeezy's License API doesn't expose a device list, so without `LEMON_SQUEEZY_API_KEY` the limit screen only lists devices registered through this app.
- The reader was verified through the automated API tests and static checks here; I haven't been able to run it in real Safari, Firefox and mobile browsers, so give those a manual pass before launch.

## Hosted setup: VPS reference (how this site is actually deployed)

The live deployment runs on an **Ubuntu VPS that already served a Laravel site on the same IP**. This app was added alongside it as a second nginx site — nothing about the Laravel site was changed. Use this section to diagnose or reproduce the deployment. Secrets are **not** recorded here; real values live only in the VPS `/opt/report-viewer/.env` and your local `.env`.

```
Internet ──> nginx :80/:443
                ├─ <laravel-domain>                  -> existing Laravel app (untouched)
                └─ reports.72.60.168.118.nip.io      -> proxy_pass 127.0.0.1:3000
                                                          └─ pm2: node server/index.js
```

- **Hostname:** `reports.72.60.168.118.nip.io` — free nip.io DNS that resolves to the VPS IP `72.60.168.118`; any hostname works the same way.
- **HTTPS:** `certbot --nginx`, renews on the existing certbot timer alongside the Laravel cert.
- **App:** cloned to `/opt/report-viewer`, run under pm2 as `report-viewer`, bound to `localhost:3000` only (never publicly exposed).
- **State:** `data/store.json` (sessions, device registry, removal quotas) — back it up.

### Fresh host install

```bash
# Node 20 + pm2. nginx already owns :80/:443 — Caddy must NOT run alongside it.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git certbot python3-certbot-nginx
sudo npm i -g pm2
sudo systemctl disable --now caddy        # only if installed; it cannot share 80/443 with nginx

git clone https://github.com/hasan-aftab/lemon-squeezy-license-key.git /opt/report-viewer
cd /opt/report-viewer
npm ci --omit=dev
```

### `.env` (production)

Create `/opt/report-viewer/.env` (git-ignored) and `chmod 600 .env`:

```bash
NODE_ENV=production
PORT=3000
TRUST_PROXY=1
PUBLIC_URL=https://reports.72.60.168.118.nip.io   # exact scheme+host you browse with
SESSION_SECRET=<openssl rand -hex 32>

STORE_ID=<lemon-squeezy store id>
PRODUCT_ID=<lemon-squeezy product id>
VARIANT_IDS=<variant ids, comma separated>
ALLOW_TEST_MODE_KEYS=true                          # only while product/keys are LS test-mode
LEMON_SQUEEZY_API_KEY=<Lemon Squeezy Settings > API key>
LEMON_WEBHOOK_SECRET=<set after the webhook is registered>

REPORT_TITLE=Confidential Market Report
REPORT_PDF_PATH=storage/report.pdf
RENDER_WIDTH=1200
SUPPORT_EMAIL=support@example.com
```

### Report PDF and data dir

The PDF is git-ignored — copy it from your machine:

```bash
scp storage/report.pdf user@VPS:/opt/report-viewer/storage/report.pdf
ssh user@VPS "cd /opt/report-viewer && mkdir -p data"
```

### Start

```bash
cd /opt/report-viewer
npm test                       # 60-check smoke test: mock Lemon, temp dir, port 3911 (safe)
pm2 start server/index.js --name report-viewer
pm2 save && pm2 startup        # run the printed sudo command → survives reboots
pm2 logs report-viewer         # expect "listening" + "Serving N pages from ..."
curl -s localhost:3000 | head -3
```

### nginx vhost (second site, Laravel untouched)

`/etc/nginx/sites-available/report-viewer`:

```nginx
server {
    listen 80;
    listen [:::]:80;
    server_name reports.72.60.168.118.nip.io;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/report-viewer /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d reports.72.60.168.118.nip.io
curl -I https://reports.72.60.168.118.nip.io      # expect HTTP/2 200
```

`X-Forwarded-Proto` + `TRUST_PROXY=1` is what lets Express see the real scheme and client IPs behind nginx.

### Lemon Squeezy webhook

Dashboard → *Settings → Webhooks*:

- URL: `https://reports.72.60.168.118.nip.io/api/webhooks/lemonsqueezy`
- Events: `license_key_created`, `license_key_updated`, `order_refunded`

Paste the signing secret into `.env` as `LEMON_WEBHOOK_SECRET=...`, then `pm2 restart report-viewer`, then send a test event and check `pm2 logs`.

### Diagnosing this deployment

- **`"Cross-site requests are not allowed."` (403 `bad_origin`) on sign-in** — `PUBLIC_URL` doesn't equal the exact origin in the address bar (scheme + host). Fix the value *or* delete the `PUBLIC_URL` line entirely (same-host fallback still blocks real cross-site requests), then **`pm2 restart report-viewer`**: config is read once at import, so editing `.env` alone changes nothing. Verify without a browser:
  ```bash
  curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: https://reports.72.60.168.118.nip.io' \
    -d '{}' https://reports.72.60.168.118.nip.io/api/license/check   # must NOT return {"error":"bad_origin",...}
  ```
- **Wrong cert in the browser** (e.g. another domain's cert) — something other than nginx/certbot owns `:443`: `sudo ss -tlnp | grep -E ':80|:443'`; if Caddy got started, `sudo systemctl disable --now caddy`.
- **503** — usually the *Laravel* app in maintenance mode, not this one. The report viewer answers 502 only when `:3000` is down: `pm2 list`, `curl -s localhost:3000`.
- **Sign-in 500 / `EROFS`** — `DATA_DIR` (or the default `data/`) isn't writable by the pm2 user.
- **Everyone signed out, device/removal limits reset** — `data/store.json` was deleted or the app runs from a fresh copy; restore the backup.
- **Placeholder pages instead of the report** — `storage/report.pdf` missing: `ls -la storage/` on the VPS, re-scp it (no restart needed).
- **Session cookie doesn't stick** — site opened over `http://`; cookies are `Secure` in production, so always use `https://`.
- **Config check** — `node --env-file=.env -e "import('./server/config.js').then(m=>m.assertConfig())"` prints errors/warnings for the current `.env`.
- Handies: `curl -s localhost:3000/healthz`, `sudo nginx -t`, `sudo certbot certificates`, `sudo journalctl -u nginx -n 50 --no-pager`.

### Day-2 operations

```bash
# Update the app
cd /opt/report-viewer && git pull && npm ci --omit=dev && pm2 restart report-viewer

# Backup (cron) — deleting store.json signs everyone out and resets removal quotas
rsync -a user@VPS:/opt/report-viewer/data/ /local/backups/report-viewer/data/

# Swap in a new report PDF (content hash re-checked per request; no restart needed)
scp report.pdf user@VPS:/opt/report-viewer/storage/report.pdf

# Later, move to a real domain: point DNS → change server_name in the vhost,
# certbot --nginx -d <domain>, update PUBLIC_URL, then:
#   sudo systemctl reload nginx && pm2 restart report-viewer
# When switching to a live-mode Lemon Squeezy product: ALLOW_TEST_MODE_KEYS=false
```

This is the `npm start` path from [Deploying](#deploying): one process (pm2, never cluster mode — the JSON store is per-process), the hourly re-validation sweep runs, and no serverless trade-offs apply.
