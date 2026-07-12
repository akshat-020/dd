import express from "express";
import cors from "cors";
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

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
