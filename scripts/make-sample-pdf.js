// Generates storage/report.pdf: a small multi-page demo report so the viewer has
// something real to render. Replace it with your actual report PDF in production.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "storage", "report.pdf");
fs.mkdirSync(path.dirname(out), { recursive: true });

const doc = new PDFDocument({ size: "LETTER", margins: { top: 64, bottom: 24, left: 64, right: 64 }, info: { Title: "Sample Confidential Report" } });
doc.pipe(fs.createWriteStream(out));

const NAVY = "#1f3a5f";
const BLUE = "#3d7ea6";
const para =
  "This paragraph is placeholder text standing in for the real analysis. It exists so you can check page layout, " +
  "image sharpness and how the watermark sits over body copy, tables and charts. Replace storage/report.pdf with your own file.";

function header(n, total, title) {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text(title, { align: "left" });
  doc.moveDown(0.2).moveTo(64, doc.y).lineTo(548, doc.y).lineWidth(2).strokeColor(NAVY).stroke().moveDown(0.8);
  doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(`Sample Report  |  Page ${n} of ${total}`, 64, 740, { align: "center", width: 484 });
  doc.x = 64;
  doc.y = 130;
}

function body(text, size = 11) {
  doc.fillColor("#1f2937").font("Helvetica").fontSize(size).text(text, { align: "justify", lineGap: 3 }).moveDown(0.8);
}

function barChart(values, labels) {
  const x0 = 80, base = doc.y + 190, w = 36, gap = 22;
  doc.fontSize(9).fillColor("#374151");
  values.forEach((v, i) => {
    const h = v * 1.6;
    doc.rect(x0 + i * (w + gap), base - h, w, h).fill(BLUE);
    doc.fillColor("#374151").text(labels[i], x0 + i * (w + gap) - 6, base + 6, { width: w + 12, align: "center" });
  });
  doc.moveTo(x0 - 10, base).lineTo(x0 + values.length * (w + gap), base).lineWidth(1).strokeColor("#9ca3af").stroke();
  doc.y = base + 40;
  doc.x = 64;
}

function table(rows) {
  const colW = [220, 130, 130];
  rows.forEach((r, ri) => {
    const y = doc.y;
    if (ri === 0) doc.rect(64, y - 2, 480, 20).fill(NAVY);
    r.forEach((cell, ci) => {
      doc.fillColor(ri === 0 ? "#ffffff" : "#1f2937").font(ri === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(cell, 70 + colW.slice(0, ci).reduce((a, b) => a + b, 0), y + 3, { width: colW[ci] - 8 });
    });
    doc.y = y + 20;
    if (ri > 0) doc.moveTo(64, doc.y - 2).lineTo(544, doc.y - 2).lineWidth(0.5).strokeColor("#e5e7eb").stroke();
  });
  doc.x = 64;
  doc.moveDown(1);
}

const pages = [
  () => {
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(34).text("Confidential Market Report", 64, 220, { width: 484 });
    doc.moveDown(0.5).fillColor(BLUE).fontSize(16).font("Helvetica").text("Sample edition for viewer testing");
    doc.moveDown(2).fillColor("#6b7280").fontSize(11).text("Prepared exclusively for licensed readers. Redistribution is prohibited and every page is watermarked with the reader's details.", { width: 380 });
  },
  (n, t) => {
    header(n, t, "1. Executive summary");
    body(para);
    body(para);
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text("Key findings").moveDown(0.4);
    ["Demand grew steadily across all measured segments.", "Margins compressed in the second half of the period.", "Three emerging players now hold double-digit share."].forEach((b) => body("•  " + b));
    body(para);
  },
  (n, t) => {
    header(n, t, "2. Market size by quarter");
    body(para);
    barChart([60, 78, 91, 70, 105, 122, 96], ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
    body(para);
  },
  (n, t) => {
    header(n, t, "3. Competitive landscape");
    table([
      ["Company", "Share", "Growth"],
      ["Northwind Co.", "28%", "+4.1%"],
      ["Contoso Ltd.", "22%", "+2.7%"],
      ["Fabrikam Inc.", "17%", "+9.3%"],
      ["Adventure Works", "11%", "-1.2%"],
      ["Others", "22%", "+0.8%"],
    ]);
    body(para);
    body(para);
  },
  (n, t) => {
    header(n, t, "4. Outlook and risks");
    body(para);
    body(para);
    body(para);
    body(para);
  },
  (n, t) => {
    header(n, t, "5. Appendix: methodology");
    body(para, 10);
    body(para, 10);
    body(para, 10);
  },
];

pages.forEach((draw, i) => {
  if (i > 0) doc.addPage();
  draw(i + 1, pages.length);
});

doc.end();
doc.on("end", () => console.log("Wrote", path.relative(process.cwd(), out)));
