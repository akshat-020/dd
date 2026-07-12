# OMS/ERP-lite — Manufacturing & Trading Business

A location-based order management and inventory system for a manufacturing/trading
business currently running on WhatsApp orders + manual stock checks + Tally-after-the-fact.
Built per the Phase 1 brief: SKU master, location master with QR codes, a real stock
ledger, and a full order → pick list → stock deduction flow, with pricing locked down
to Owner/Accountant at the API level.

## Architecture

```
server/   Express + TypeScript + Prisma API (SQLite for local dev)
web/      React + Vite + TypeScript PWA (mobile-first, offline-capable picking app)
```

Tally is **not replaced**. `InvoiceReference` is a thin layer that links an order to a
Tally invoice number and keeps inventory in sync (see "Pricing & Invoicing" below).

### Why SQLite for dev

Prisma's schema is otherwise plain relational SQL — there's nothing SQLite-specific in
the data model (the only accommodation was modeling `Role` as a validated `String`
instead of a native enum, since Prisma+SQLite doesn't support enums). To run against
Postgres for production, change `provider = "sqlite"` to `"postgresql"` in
`server/prisma/schema.prisma` and point `DATABASE_URL` at a Postgres instance — no
application code changes required.

## Getting started

```bash
npm install                          # installs both workspaces

# Server
cp server/.env.example server/.env   # DATABASE_URL, JWT_SECRET, PORT
npm run dev:server --workspace server   # or: cd server && npm run dev
cd server && npx tsx prisma/seed.ts     # seed demo users/SKUs/locations

# Web (in a separate terminal)
npm run dev:web --workspace web         # or: cd web && npm run dev
```

The web dev server proxies `/api/*` to `http://localhost:4000`, so just visit the Vite
URL (default `http://localhost:5173`).

Seeded logins (all `password123`): `owner@example.com`, `accountant@example.com`,
`sales@example.com`, `warehouse@example.com`.

### Tests

```bash
npm run test:server --workspace server
```

21 tests cover: RBAC (price fields are structurally absent from API responses for
Sales/Warehouse, not just hidden), the full order → finalize → pick → invoice flow,
wrong-item/wrong-location pick rejection, stock ledger correctness (putaway, transfer,
insufficient-stock rejection), and invoice cancellation reversing stock.

## Core design: location QR + self-printed SKU labels

Per the brief, this does **not** require manufacturer barcodes. Two label types:

1. **Location label** — printed on every rack/bin at Location Master creation, encodes
   the location `code` (e.g. `A-03-02`). Generate via `GET /api/locations/:id/qr`, or
   print a full sheet from the Locations page.
2. **SKU batch label** — generated the moment a purchase/production entry is logged
   (`POST /api/stock/batches`), encoding `SKU:<code>|BATCH:<code>|DATE:<yyyy-mm-dd>`.
   This gives batch/lot traceability for free.

Picking and putaway both use a **scan-location → scan-SKU → confirm qty** flow
(`web/src/pages/PickingSession.tsx`, `web/src/pages/Receiving.tsx`): the server
rejects a confirm if the scanned location or SKU label doesn't match the expected
value, which is what catches wrong-bin/wrong-item picks before goods leave the
warehouse (see `server/src/routes/picking.ts`).

Camera scanning uses `qr-scanner` (phone camera, no dedicated hardware). Every scan
screen also has a manual text-entry fallback for low light / no camera / testing.

## Roles & pricing confidentiality

Enforced server-side, not just hidden in the UI:

- `OrderLinePrice` is a **separate table** from `OrderLine`, joined in only for
  Owner/Accountant requests (`server/src/routes/orders.ts` `serializeOrder`). Sales
  and Warehouse responses never include a `price`/`unitPrice` key — there's nothing to
  hide client-side because the field was never serialized.
- `/api/orders/:id/pricing` and `/api/invoice-references/*` are mounted behind
  `requireRole("OWNER", "ACCOUNTANT")` at the route level.
- Warehouse/picking endpoints (`/api/picking/*`) never touch price tables at all.

See `server/src/lib/roles.ts` and the roles table in the brief for the full matrix.

## Pricing & Invoicing (Tally stays system of record)

- **Add Invoice Reference**: attaches a Tally invoice number + priced lines to an
  order. Does not touch stock (dispatch already deducted it).
- **Cancel Invoice Reference**: `reverseStock: true` restores the picked quantities
  back to the exact locations they were picked from (walks the order's
  `PickListItem`s); `reverseStock: false` is a paperwork-only void.
- **Adjust Invoice Reference**: editing a line's qty posts a signed `ADJUSTMENT` stock
  movement tagged with the invoice number, so the audit log shows why a stock/price
  number changed (e.g. billed weight vs. dispatched weight).

## What's built (Phase 1) vs. deferred (Phase 2/3)

**Built:**
- SKU master, Location master (Zone/Rack/Bin) with QR generation + bulk import + a
  printable label sheet.
- Stock ledger: every movement (inbound, outbound, transfer, adjustment) is an
  append-only row; `StockItem` quantities are derived from it via a single
  `applyStockMovement` chokepoint (`server/src/lib/stock.ts`) so the ledger can't drift.
- Order intake with live stock-check, draft editing (qty/vehicle-capacity adjustments),
  finalize → auto-allocates stock to specific bins and generates a location-sequenced
  pick list.
- Two-tier scan picking/putaway (location + SKU-batch label), mobile-first PWA.
- Offline queue for the picking app (`web/src/offline/`): pick list is cached in
  IndexedDB (Dexie) on load; scans/confirms made while offline are validated against
  the cached expected values, applied optimistically to the UI, and queued to sync the
  moment connectivity returns.
- RBAC enforced server-side; pricing/invoice-reference module; reports (stock-on-hand,
  fulfillment turnaround, sales, audit log).

**Deferred (per brief, Section 7):**
- Phase 2: WhatsApp/photo order parsing (OCR + LLM → draft order for human
  confirmation), direct Tally sync/export, low-stock push alerts.
- Phase 3: route-optimized picking sequence (current sequencing is a simple
  location-code sort, not a true shortest-path), analytics/trend dashboards,
  optional manufacturer-style SKU barcodes if adopted later.
