import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as mupdf from "mupdf";
import sharp from "sharp";
import { config } from "./config.js";

/**
 * Page renderer. The PDF is read from disk on the server and turned into page
 * images; the PDF itself is never exposed. Each image sent to a reader is
 * re-composited per request with that reader's name, email and order number,
 * so no two buyers ever receive the same bytes.
 */

const FONT = path.join(config.paths.fonts, "DejaVuSans.ttf");
const FONT_BOLD = path.join(config.paths.fonts, "DejaVuSans-Bold.ttf");
const CACHE_DIR = path.join(config.paths.data, "cache");
const PLACEHOLDER_PAGES = 6;
const LRU_MAX = 8;

const RENDER_W = config.report.renderWidth;
const clean = new Map(); // in-memory LRU of un-watermarked base pages (never sent to clients)

let source = null; // { kind, count, sig, doc? }

// --- source (PDF or placeholder) ------------------------------------------------

function getSource() {
  const file = config.report.pdfPath;
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    /* no PDF: use placeholder pages */
  }

  if (!st) {
    if (source?.kind !== "placeholder") {
      source = { kind: "placeholder", count: PLACEHOLDER_PAGES, sig: `placeholder-${RENDER_W}` };
      clean.clear();
    }
    return source;
  }

  const sig = crypto.createHash("sha1").update(`${st.size}:${st.mtimeMs}:${RENDER_W}`).digest("hex").slice(0, 16);
  if (!source || source.sig !== sig) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
    source = { kind: "pdf", doc, count: doc.countPages(), sig };
    clean.clear();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return source;
}

export const sourceInfo = () => {
  const s = getSource();
  return { kind: s.kind, pages: s.count };
};
export const pageCount = () => getSource().count;

// --- clean base pages --------------------------------------------------------------

async function basePage(n) {
  const src = getSource();
  const key = `${src.sig}-${n}`;

  const hit = clean.get(key);
  if (hit) {
    clean.delete(key);
    clean.set(key, hit); // refresh LRU position
    return hit;
  }

  const diskFile = path.join(CACHE_DIR, `${key}.png`);
  let png = null;
  if (src.kind === "pdf") {
    try {
      png = fs.readFileSync(diskFile);
    } catch {
      png = renderPdfPage(src.doc, n);
      fs.writeFileSync(diskFile, png, { mode: 0o600 });
    }
  } else {
    png = await placeholderPage(n, src.count);
  }

  clean.set(key, png);
  while (clean.size > LRU_MAX) clean.delete(clean.keys().next().value);
  return png;
}

function renderPdfPage(doc, n) {
  const page = doc.loadPage(n - 1);
  try {
    const [x0, , x1] = page.getBounds();
    const scale = RENDER_W / (x1 - x0);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return Buffer.from(pix.asPNG());
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

// --- text helpers (bundled font so output is identical on every host) ---------------

const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Render one line of text to a transparent PNG at roughly the requested pixel height. */
async function textImage(markupText, { color, alpha, bold = false, heightPx, maxWidthPx }) {
  const raw = await sharp({
    text: {
      text: `<span foreground="${color}" alpha="${alpha}%">${markupText}</span>`,
      font: bold ? "DejaVu Sans Bold" : "DejaVu Sans",
      fontfile: bold ? FONT_BOLD : FONT,
      rgba: true,
      dpi: 220,
    },
  })
    .png()
    .toBuffer();

  const m = await sharp(raw).metadata();
  let h = heightPx;
  let w = Math.round((m.width / m.height) * h);
  if (maxWidthPx && w > maxWidthPx) {
    w = maxWidthPx;
    h = Math.round((m.height / m.width) * w);
  }
  return sharp(raw).resize({ width: Math.max(1, w), height: Math.max(1, h) }).png().toBuffer();
}

// --- placeholder pages (used when no PDF is present) ----------------------------------

async function placeholderPage(n, total) {
  const w = RENDER_W;
  const h = Math.round(w * 1.294); // US Letter
  const pad = Math.round(w * 0.08);

  const shapes = [`<rect width="${w}" height="${h}" fill="#ffffff"/>`, `<rect x="${pad}" y="${pad + 70}" width="${w - 2 * pad}" height="3" fill="#1f3a5f"/>`];
  const layers = [];

  const title = await textImage(esc(`Sample Report  -  Page ${n} of ${total}`), { color: "#1f3a5f", alpha: 100, bold: true, heightPx: Math.round(w * 0.034), maxWidthPx: w - 2 * pad });
  layers.push({ input: title, left: pad, top: pad });

  // Body: grey "text" bars standing in for paragraphs.
  let y = pad + 130;
  for (let i = 0; i < 14; i++) {
    const bw = Math.round((w - 2 * pad) * (i % 5 === 4 ? 0.55 : 0.96 - (i % 3) * 0.04));
    shapes.push(`<rect x="${pad}" y="${y}" width="${bw}" height="14" rx="7" fill="#d9dee5"/>`);
    y += 34 + (i % 5 === 4 ? 26 : 0);
  }

  // A fake chart so the page has some "content" that varies per page.
  const chartTop = y + 30;
  const bars = 7;
  const bwid = Math.round((w - 2 * pad) / (bars * 1.6));
  for (let i = 0; i < bars; i++) {
    const bh = 80 + ((i * 53 + n * 37) % 220);
    shapes.push(`<rect x="${pad + i * bwid * 1.6}" y="${chartTop + 300 - bh}" width="${bwid}" height="${bh}" fill="#3d7ea6"/>`);
  }
  shapes.push(`<rect x="${pad}" y="${chartTop + 304}" width="${w - 2 * pad}" height="2" fill="#1f3a5f"/>`);

  const base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${shapes.join("")}</svg>`))
    .png()
    .toBuffer();
  return sharp(base).composite(layers).png().toBuffer();
}

// --- watermark ---------------------------------------------------------------------------

/**
 * Diagonal, repeating name/email/order watermark across the whole page, plus a small
 * footer with a reference id so a leaked image can be traced to a session.
 */
async function applyWatermark(basePng, ident) {
  const { width: w, height: h } = await sharp(basePng).metadata();

  const line = `${ident.customerName}  ·  ${ident.customerEmail}  ·  Order #${ident.orderNumber}`;
  const textH = Math.round(w * 0.026);
  const textPng = await textImage(esc(line), { color: "#1b1b1b", alpha: 24, bold: true, heightPx: textH, maxWidthPx: Math.round(w * 0.78) });
  const tm = await sharp(textPng).metadata();

  const angle = -30;
  const tile = await sharp(textPng)
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const rm = await sharp(tile).metadata();

  // Lattice: tiles run end-to-end along the diagonal; rows are offset vertically.
  const rad = (Math.abs(angle) * Math.PI) / 180;
  const along = tm.width + Math.round(w * 0.06); // distance between tile centres along the line
  const ux = Math.cos(rad) * along;
  const uy = -Math.sin(rad) * along;
  const rowGap = Math.round(textH * 5.2); // vertical distance between diagonal lines

  const overlays = [];
  const cx0 = w / 2;
  const cy0 = h / 2;
  const span = Math.ceil((Math.hypot(w, h) / Math.min(along, rowGap)) * 1.2) + 2;
  for (let j = -span; j <= span; j++) {
    for (let i = -span; i <= span; i++) {
      const cx = cx0 + i * ux;
      const cy = cy0 + i * uy + j * rowGap;
      const left = Math.round(cx - rm.width / 2);
      const top = Math.round(cy - rm.height / 2);
      if (left + rm.width <= 0 || top + rm.height <= 0 || left >= w || top >= h) continue;
      overlays.push({ input: tile, left, top });
    }
  }

  // Footer: licensee, device and a trace reference.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const footerText = `Licensed to ${ident.customerName} <${ident.customerEmail}>  ·  Order #${ident.orderNumber}  ·  ${ident.deviceLabel}  ·  ${stamp}  ·  Ref ${ident.ref}`;
  const footer = await textImage(esc(footerText), { color: "#222222", alpha: 70, heightPx: Math.round(w * 0.0105), maxWidthPx: w - 2 * Math.round(w * 0.04) });
  const fm = await sharp(footer).metadata();
  overlays.push({ input: footer, left: Math.round((w - fm.width) / 2), top: h - fm.height - Math.round(w * 0.018) });

  return sharp(basePng)
    .composite(overlays)
    .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/**
 * Public entry point: a watermarked JPEG for page n (1-based).
 * ident: { customerName, customerEmail, orderNumber, deviceLabel, ref }
 */
export async function renderWatermarkedPage(n, ident) {
  const count = pageCount();
  if (!Number.isInteger(n) || n < 1 || n > count) {
    const err = new Error("Page not found");
    err.status = 404;
    throw err;
  }
  return applyWatermark(await basePage(n), ident);
}
