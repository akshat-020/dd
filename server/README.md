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
cp server/.env.example server/.env   # see "Environment variables" below
npm run dev:server --workspace server   # or: cd server && npm run dev
cd server && npx tsx prisma/seed.ts     # seed demo users/SKUs/locations

# Web (in a separate terminal)
npm run dev:web --workspace web         # or: cd web && npm run dev
```

The web dev server proxies `/api/*` to `http://localhost:4000`, so just visit the Vite
URL (default `http://localhost:5173`).

Seeded logins (all `password123`): `owner@example.com`, `accountant@example.com`,
`sales@example.com`, `warehouse@example.com`.

### Environment variables

`server/.env.example` lists all of these; the ones added for security hardening:

| Variable | Purpose | Default if unset |
| --- | --- | --- |
| `WEB_ORIGIN` | Comma-separated CORS allowlist (browser origins allowed to call the API) | none — unlisted origins are rejected |
| `FIELD_ENCRYPTION_KEY` | 32-byte AES-256-GCM key (base64 or hex) encrypting all price/cost columns at rest | **required** — server refuses to start without it |
| `REQUIRE_HTTPS` | If `"true"`, rejects any request not received over TLS (via `req.secure` or `x-forwarded-proto`) | `false` |
| `SESSION_INACTIVITY_MINUTES` | Minutes of inactivity before a login session auto-expires | `30` |

Generate a key with `openssl rand -base64 32`. Losing this key makes all stored
price/cost data unrecoverable — back it up somewhere other than the database itself.

### Tests

```bash
npm run test:server --workspace server
```

57 tests across 4 files cover: RBAC (price fields are structurally absent from API
responses for Sales/Warehouse, not just hidden), the full order → finalize → pick →
invoice flow, wrong-item/wrong-location pick rejection, stock ledger correctness
(putaway, transfer, insufficient-stock rejection), invoice cancellation reversing
stock, the composable `canScanPutaway`/`canLogInwardEntry` permission grants, and the
security hardening described below: password policy, session revocation/inactivity
expiry, remote session revocation authorization, login audit logging, the audit-log
tamper-evident hash chain (including a test that directly mutates a DB row and asserts
the chain detects it), field-level encryption at rest (asserting the raw DB value is
never the plaintext number), the full TOTP 2FA enroll → confirm → login flow, and login
rate limiting.

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

## Security

Implemented against a 9-section security requirements document. The guiding rule:
**every request is authenticated and independently authorized on the server for the
specific data it touches** — a link, a guessed ID, or a hidden UI element never grants
access on its own, and pricing/cost data never leaves the server for a user who isn't
permitted to see it.

**Authentication**
- Every route requires a valid session; there is no link-bypass or unauthenticated
  read path (`server/src/middleware/auth.ts`).
- Password policy enforced server-side on account creation/change: minimum 8
  characters, at least one letter and one number (`server/src/lib/password.ts`).
- No shared logins by design — one `User` row per person, sessions are per-login, and
  the Owner can see and revoke any user's active sessions individually
  (`server/src/routes/sessions.ts`, `web/src/pages/Security.tsx`).
- Optional TOTP 2FA (Owner/Accountant, or any account) — enroll via a QR code
  generated **client-side** (`qrcode` npm package) so the TOTP secret never touches a
  third-party image service; login requires the code once enabled
  (`server/src/lib/totp.ts`, `server/src/routes/auth.ts`).
- Login is rate-limited (10 attempts / 15 min per client) to slow down password
  guessing (`server/src/lib/security.ts`).

**Authorization**
- Every sensitive route re-checks role/permission server-side on every request —
  nothing is enforced only in the UI. Price/cost fields live in physically separate
  tables/columns (`OrderLinePrice`, `InvoiceReferenceLine.price`,
  `PurchaseCostReference.unitCost`) so they can be omitted from the Prisma
  `select`/`include` entirely for unauthorized roles, not just stripped or hidden
  client-side.
- Object-level checks: order/pick/invoice endpoints verify the requesting user is
  allowed to act on *that specific* record, not just that their role can hit the route.

**Session & device security**
- Sessions are tracked server-side (`Session` table), not just a stateless JWT, so they
  can be revoked before natural expiry. Inactivity auto-expires a session
  (`SESSION_INACTIVITY_MINUTES`, default 30) — checked and refreshed on every
  authenticated request (`server/src/lib/session.ts`).
- A user can sign out of all their other sessions from `/security`; an Owner can revoke
  any user's session remotely, immediately invalidating it on that user's very next
  request.

**Data protection**
- Price/cost fields are encrypted at rest with AES-256-GCM
  (`server/src/lib/crypto.ts`), key from `FIELD_ENCRYPTION_KEY`. The raw DB value is an
  opaque `iv.authTag.ciphertext` string — decrypted only in the API layer, only for
  authorized roles.
- QR labels encode only identifiers (`SKU:code|BATCH:code|DATE:date`, location code) —
  never price, cost, or any other sensitive field.
- API responses are built by explicit field selection per role, not by fetching
  everything and filtering — there's no code path that assembles a response containing
  data the requester isn't entitled to and then trims it.

**Outside/external access**
- `X-Robots-Tag: noindex, nofollow, noarchive` on every response (`server/src/lib/security.ts`).
- CORS locked to an explicit `WEB_ORIGIN` allowlist — previously wide open.
- Error responses are generic (`"Internal server error"`) with details logged
  server-side only, not returned to the client.

**Application-level attack protection**
- SQL injection: not applicable in practice — all queries go through Prisma's
  parameterized query builder, no raw string-interpolated SQL anywhere.
- XSS: React escapes all rendered output by default; no `dangerouslySetInnerHTML`
  usage in the app.
- CSRF: the API is token-authenticated (`Authorization: Bearer`, not cookies), which
  isn't subject to classic CSRF; combined with the CORS allowlist, a third-party page
  can't ride a logged-in session.
- Rate limiting: login (10/15min) and general API (300/min) via `express-rate-limit`.
- Input validation: every route validates its body/query with Zod schemas before
  touching the DB.
- Security headers via `helmet` (`server/src/app.ts`).
- Dependency hygiene: `npm audit` run and triaged (see below).

**Audit logging & monitoring**
- Every sensitive action is recorded: logins (success and failure), permission
  grants/revokes, pricing/invoice changes, stock movements, 2FA enroll/disable, session
  revocations (`server/src/lib/audit.ts`).
- The audit log is tamper-evident: each row's hash covers its own content plus the
  previous row's hash (a SHA-256 hash chain), so altering any historical row breaks the
  chain from that point forward. `GET /api/reports/audit-log/verify` (Owner-only)
  recomputes and reports whether the chain is intact.
- Periodic anomaly review (e.g. reviewing repeated `LOGIN_FAILURE` entries or unusual
  `GRANT_*` activity) is an operational process, not something code can automate away —
  the audit log and its integrity check are the tooling for that review, not a
  replacement for someone doing it.

**Backup & recovery**
- `server/scripts/backup.sh` dumps the database and encrypts it with
  `openssl enc -aes-256-cbc -pbkdf2` (works against both the SQLite dev DB and
  Postgres via `pg_dump`). Restore is a one-line `openssl enc -d` documented at the top
  of the script.

**Tally integration security**
- The existing `InvoiceReference` layer already validates shape (Zod) and business
  invariants (stock availability, existing order state) before accepting data tied to a
  Tally invoice number. There is no live Tally sync yet (see "Deferred" below); when one
  is built, credentials for it must go through the same encryption-at-rest path as
  price/cost data, not plain environment variables or a config file.

### What's a hosting/deployment decision, not app code

These items from the security requirements are real, but can't be decided or enforced
from inside this codebase — they depend on where and how this is deployed:

- **TLS certificate termination.** The app has `REQUIRE_HTTPS` to *enforce* HTTPS-only
  once it's in place, but issuing/terminating the certificate itself is a hosting
  platform or reverse-proxy job (e.g. a managed platform's automatic TLS, or nginx +
  Let's Encrypt on a self-managed box).
- **VPN / network-level restriction for pricing screens**, if wanted in addition to the
  existing role-based restriction — that's a network/firewall configuration outside the
  application.
- **Backup scheduling and off-site storage destination.** `backup.sh` does the
  dump-and-encrypt step; actually running it on a schedule (cron, a platform's
  scheduled jobs) and shipping the encrypted file somewhere other than this machine
  (S3, another server) is a deployment decision.
- **Ongoing dependency-patching cadence.** `npm audit` was run and triaged once (see
  below) — keeping that current over time is a process, not a one-time code change.

`npm audit` currently reports 5 findings, all rooted in `esbuild`'s dev-server CORS
behavior, affecting only the Vite/Vitest dev toolchain (`devDependencies`) — never
shipped in the built app or exposed to the internet. No non-breaking fix is available
yet (it requires a Vitest v4 major upgrade); flagged here for future attention rather
than force-upgraded mid-project.

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
