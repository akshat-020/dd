import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { skusRouter } from "./routes/skus.js";
import { locationsRouter } from "./routes/locations.js";
import { stockRouter } from "./routes/stock.js";
import { ordersRouter } from "./routes/orders.js";
import { pickingRouter } from "./routes/picking.js";
import { pricingRouter } from "./routes/pricing.js";
import { invoiceReferencesRouter } from "./routes/invoiceReferences.js";
import { reportsRouter } from "./routes/reports.js";
import { sessionsRouter } from "./routes/sessions.js";
import { putBacksRouter } from "./routes/putBacks.js";
import { settingsRouter } from "./routes/settings.js";
import { proformaInvoicesRouter } from "./routes/proformaInvoices.js";
import { openingStockRouter } from "./routes/openingStock.js";
import { corsOptions, apiRateLimit, loginRateLimit, enforceHttps, noIndex } from "./lib/security.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(enforceHttps);
  app.use(noIndex);
  app.use(express.json({ limit: "1mb" }));

  app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // CORS only gates /api — restricting it is what stops a third-party page
  // from making credentialed-looking API calls against this app. Applying
  // it globally also caught the served static frontend's own asset
  // requests: Vite marks its built <script type="module"> and stylesheet
  // tags `crossorigin`, which makes the browser send an Origin header (and
  // therefore triggers the CORS check) even for same-origin loads — so a
  // global CORS allowlist that doesn't happen to include this exact origin
  // broke the app's own JS/CSS from loading.
  app.use("/api", cors(corsOptions));
  app.use("/api", apiRateLimit);
  app.use("/api/auth/login", loginRateLimit);

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/skus", skusRouter);
  app.use("/api/locations", locationsRouter);
  app.use("/api/stock", stockRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/picking", pickingRouter);
  app.use("/api/orders", pricingRouter);
  app.use("/api/invoice-references", invoiceReferencesRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/put-backs", putBacksRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/proforma-invoices", proformaInvoicesRouter);
  app.use("/api/opening-stock", openingStockRouter);

  // Serves the built frontend when present, so a single deployed service
  // can host both API and web app (one URL, no CORS to configure between
  // them). In local dev the web app runs separately via Vite
  // (`npm run dev:web`) and web/dist doesn't exist, so this is skipped —
  // dev behavior is unchanged.
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDistDir = path.resolve(dirname, "../../web/dist");
  if (fs.existsSync(path.join(webDistDir, "index.html"))) {
    app.use(express.static(webDistDir));
    // Client-side routing (React Router) — any non-API, non-file GET falls
    // through to index.html so a hard refresh on e.g. /orders/123 works.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  // Deliberately generic — never forward err.message or a stack trace to
  // the client, since either can leak internals (query fragments, file
  // paths, library versions) useful to an attacker. Full detail goes to the
  // server log only.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
