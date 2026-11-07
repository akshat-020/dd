# Combined Plan — Call Desk + OMS go-live

> Companion to [CALL_DESK_SYSTEM.md](CALL_DESK_SYSTEM.md). Costs are monthly INR
> estimates to verify with vendors.

**Status (7 Nov 2026):** two-track plan **approved** by the founder.
Track B week-1 code is done in this repo:
- G1 (Contacts/party master + order linking) — done.
- G2 (integration key + caller lookup endpoint) — done.
- G3 (always-on hosting in `render.yaml`) — done; switching the plan on Render is a
  billing decision.
- G4 (shared WhatsApp account) — pending; it starts with call-desk Phase 1.
- Not built yet: pending-order *value* in the lookup, for the ₹2 lakh escalation. It
  needs a price-derived flag; decide whether the front desk may see it.
See the README section "Contacts (party master) & call-desk caller lookup".

## 1. Can each be done standalone? (checked)

| Question | Answer | Evidence |
|---|---|---|
| Can the **call desk** run without the OMS? | **Yes.** Phases 0–2 don't touch order data. Only "where is my order?" needs it; a Dispatch Sheet covers that until the OMS is live. | Call-desk design §9.6; its routing uses only the contact sheet. |
| Can the **OMS** go live without the call desk? | **Yes.** It is self-contained: it has no telephony or WhatsApp dependency, and its own logins, roles, stock ledger and picking. | `server/package.json` has no telephony/WhatsApp packages; WhatsApp order parsing is listed as deferred in `README.md`. |
| Can they **talk to each other today**? | **Not yet.** There are 4 gaps (below). Each is small, but none is built. | See §2. |

**Not checked:** I didn't run the OMS test suite in this session (no Postgres server
here), and I can't see how much real master data (SKUs, locations, opening stock) is
loaded. Those decide how ready the OMS really is.

## 2. Where they meet (integration gaps found in the code)

| # | Gap | Why it matters | Fix | Size |
|---|---|---|---|---|
| G1 | **No party/customer master.** An order stores `buyerName` + an optional free-text `buyerContact` (`server/prisma/schema.prisma`, model `Order`). | A phone number can't reliably be matched to a buyer ("98xxx", "+91 98xxx" and "Sharma ji" are all different strings). | Add a `Party` table (name, firm, city, phones in +91 format, tag, owner staff) and link orders to it. **The call desk's contact sheet becomes this table**, so one tagging exercise serves both. | 3–5 dev days |
| G2 | **Only user logins.** Auth is user sessions that expire after 30 min of inactivity (`server/src/middleware/auth.ts`); there's no machine/API token. | The phone system can't safely ask the OMS "who is this number, any open orders?" | Add a read-only **integration token** for 2 endpoints: party lookup by phone, and open-order status by phone. No prices returned. | 2–3 dev days |
| G3 | **Free hosting sleeps.** The Render free tier spins down after ~15 min; waking takes 30–60 s (`README.md`). | A routing lookup that takes 30 s would mean callers hear silence. | Move to a paid always-on plan (~₹600–2,000/mo, verify). Keep the call desk's **2-second timeout → ring front desk** fail-safe regardless. | Config change |
| G4 | **No WhatsApp in the OMS yet** (deferred to its Phase 2). | Both systems want the same office WhatsApp number (call acks/alerts now, order intake later). | Use **one** WhatsApp Business API account (BSP) for both. The call desk sets it up first; OMS order intake plugs in later. | Shared setup |

## 3. Is "combined" better? (three lenses)

- **Founder:** one combined rollout is attractive, but launching two new systems on staff
  in the same week risks both. The real win is that **the front-desk hire can also enter
  phone and WhatsApp orders into the OMS**. That makes one salary do two jobs, and it gets
  orders into the OMS without burdening Rohit.
- **PM:** the call desk gives fast wins (days). The OMS needs master data, QR labels and
  warehouse habit change (weeks). Coupling them makes the call desk wait for the slower
  one. But two separate contact lists and a throwaway Dispatch Sheet are waste.
- **Builder:** the shared seams are small (G1–G4). Building them now is cheap; building
  the call desk's ticket system twice (AppSheet, then OMS) is not.

**Recommendation: "two tracks, one master, three joins."**
- Launch the two **separately**, staggered, so neither waits for the other.
- Share **one party/contact master** from Day 1.
- Join them at three points (§4). Don't do a big-bang launch.

## 4. The combined plan

### Track A — Call desk (unchanged dates; never blocked by the OMS)
Phase 0 (days 1–3) → Phase 1 (weeks 1–2) → Phase 2 (weeks 3–6), as in the main design.

### Track B — OMS go-live in slices (not all at once)

| Slice | When | What goes live | Who uses it | Go/no-go |
|---|---|---|---|---|
| B0 Prep | Weeks 1–2 | Fix G1 (Party table) + G3 (paid hosting); load SKU master; create staff logins | Freelancer/dev + Sunita | Test suite green; founder can log in on phone |
| B1 Orders + status only | Weeks 3–4 | Order entry + status (Draft → Finalized → Loaded → Dispatched). **No stock scanning yet.** Replaces the Dispatch Sheet. | Front desk enters phone/WhatsApp orders as drafts; Rohit finalizes; Ramesh marks Loaded/Dispatched | 1 week with every order in the OMS; Dispatch Sheet retired |
| B2 Stock + picking | Weeks 6–10 | Location QR labels, opening stock, scan picking | Warehouse | 2 weeks of pick accuracy and no stock mismatch vs. a physical count |
| B3 Pricing/Tally refs | After B2 | Invoice references, proformas | Sunita, founder | Matches Tally for 2 weeks |

### The three joins

| Join | When | What it does | Needs |
|---|---|---|---|
| J1 **One contact master** | Day 1 | The call desk's tagged contact sheet is imported as OMS parties at B0, and stays synced (nightly sheet → OMS, or the OMS becomes the master once B1 is live) | G1 |
| J2 **Order status on ring** | After B1 (≈ week 4–5) | When a buyer calls, the front desk sees their open orders and status. Pending-order value ≥ ₹2 lakh triggers the "high value" escalation. | G1, G2, G3 |
| J3 **Tickets move into the OMS** | Month 2–3, optional | Call log + tickets live in the OMS instead of AppSheet: one login and one access-control system (finance/personal restrictions reuse OMS roles). | G2; only if AppSheet limits bite |

### Calendar (one change per week for staff)

| Week | Call desk (Track A) | OMS (Track B) |
|---|---|---|
| 1 | Phase 0 live: tagging, forwarding, missed-call acks | Dev starts G1/G3 (no staff impact) |
| 2 | Cloud line + front desk start | Load SKU master; staff logins |
| 3 | Recording, AppSheet log, digest | — (let the call desk settle) |
| 4 | Transcription bake-off | **B1: orders + status live**; front desk enters orders |
| 5 | Summaries + callback tracking | J2: order status on ring |
| 6 | AI voice, after hours only | Prepare QR labels / opening stock |
| 7–10 | Stabilise | B2: stock + picking |
| 11+ | Phase 3 follow-ups | J3 if needed; B3 |

## 5. Cost impact (vs. running them separately)

| Item | Separate | Combined |
|---|---|---|
| Contact tagging | Done twice (call desk + OMS party list) | **Once** |
| Dispatch Sheet | Maintained until the OMS is live, then thrown away | Retired at week 4 |
| Order entry staff | Rohit enters orders (if at all) | **Front desk** enters drafts (salary already budgeted) |
| WhatsApp API | Possibly 2 setups | **1** BSP account |
| Extra build | — | G1 + G2 ≈ 5–8 dev days (₹25–60k one-time, est.) |
| Hosting | Free tier (unsuitable for live lookups) | Paid always-on, ₹600–2,000/mo (est.) |

## 6. Risks specific to combining

| Risk | Mitigation |
|---|---|
| OMS slips and drags the call desk | Track A has **no dependency** on Track B; J2 simply waits. |
| Staff overload (new phone flow + new software) | One change per week (calendar above); B2 warehouse scanning only after the call desk is stable. |
| OMS outage breaks call routing | Routing never waits more than 2 s for the OMS; it falls back to the cached contact sheet → front desk. |
| Front desk overloaded doing calls + order entry | Orders entered as drafts only (Rohit finalizes). If calls exceed ~150/day, a part-time second person covers peaks. |
| Prices leak via the order lookup | The integration token returns status/quantities only, never prices (the OMS already keeps prices in a separate, role-restricted table). |

## 7. Decisions needed from the founder

1. Approve "two tracks, one master": call desk starts this week; OMS go-live starts with
   orders + status in week 4.
2. Confirm the front desk will also enter orders (affects hiring: basic typing in
   Hindi/English needed).
3. Approve ~₹25–60k one-time for G1/G2 and moving the OMS to paid hosting.
