import { config, assertConfig } from "./config.js";
import { createApp } from "./app.js";
import { startRevalidationSweep } from "./auth.js";
import { sourceInfo } from "./pages.js";

assertConfig();

const app = createApp();

app.listen(config.port, () => {
  const info = sourceInfo();
  console.log(`Report viewer listening on http://localhost:${config.port}`);
  console.log(
    info.kind === "pdf"
      ? `Serving ${info.pages} pages from ${config.report.pdfPath}`
      : `No PDF at ${config.report.pdfPath} - serving ${info.pages} generated placeholder pages (run "npm run sample-pdf" for a sample PDF)`
  );
});

// Hourly: purge expired sessions and re-check any session whose 7-day validation is due.
startRevalidationSweep();
