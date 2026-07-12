import express from "express";
import cors from "cors";
import helmet from "helmet";
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
import { corsOptions, apiRateLimit, loginRateLimit, enforceHttps, noIndex } from "./lib/security.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(enforceHttps);
  app.use(cors(corsOptions));
  app.use(noIndex);
  app.use(express.json({ limit: "1mb" }));

  app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

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
