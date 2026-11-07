import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { normalizePhone, parsePartyTag } from "../src/lib/parties.js";
import { hashIntegrationToken } from "../src/lib/integrationTokens.js";
import { createUser } from "./helpers.js";

// Party/contact master + call-desk caller lookup
// (docs/call-desk/COMBINED_PLAN.md, gaps G1 and G2).

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let sales: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;
let skuId: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, sales, warehouse] = await Promise.all([createUser("OWNER"), createUser("SALES"), createUser("WAREHOUSE")]);
  const sku = await prisma.sku.create({ data: { code: "PARTY-SKU-1", name: "Party test widget", unit: "pc" } });
  skuId = sku.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("normalizePhone", () => {
  it.each([
    ["9812345678", "+919812345678"],
    ["098123 45678", "+919812345678"],
    ["+91-98123-45678", "+919812345678"],
    ["919812345678", "+919812345678"],
    ["00919812345678", "+919812345678"],
    ["0141 2345678", "+911412345678"],
    ["+14155550123", "+14155550123"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "12345", "0000000000", "98123456789012", "abc", "+910812345678"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("accepts the tag spellings people type in a sheet", () => {
    expect(parsePartyTag("vip-family")).toBe("VIP_FAMILY");
    expect(parsePartyTag("Buyer Top")).toBe("BUYER_TOP");
    expect(parsePartyTag("customer")).toBeNull();
  });
});

describe("party master", () => {
  it("creates a party with normalized, de-duplicated phones and rejects a phone owned by another party", async () => {
    const res = await request(app)
      .post("/api/parties")
      .set(auth(sales.token))
      .send({ name: "Mukesh", firm: "Mukesh Hardware", city: "Kota", tag: "lead", phones: [{ phone: "098100 00001" }, { phone: "+91 9810000001" }] });
    expect(res.status).toBe(201);
    expect(res.body.tag).toBe("LEAD");
    expect(res.body.phones.map((p: any) => p.phone)).toEqual(["+919810000001"]);

    const dup = await request(app).post("/api/parties").set(auth(sales.token)).send({ name: "Someone else", phones: [{ phone: "9810000001" }] });
    expect(dup.status).toBe(409);

    const bad = await request(app).post("/api/parties").set(auth(sales.token)).send({ name: "Bad", phones: [{ phone: "12345" }] });
    expect(bad.status).toBe(400);
  });

  it("only the Owner can assign or remove VIP-class tags", async () => {
    const denied = await request(app).post("/api/parties").set(auth(sales.token)).send({ name: "Top buyer", tag: "BUYER_TOP", phones: [{ phone: "9810000002" }] });
    expect(denied.status).toBe(403);

    const created = await request(app).post("/api/parties").set(auth(owner.token)).send({ name: "Agarwal Steel", tag: "BUYER_TOP", phones: [{ phone: "9810000002" }] });
    expect(created.status).toBe(201);

    const demote = await request(app).patch(`/api/parties/${created.body.id}`).set(auth(sales.token)).send({ tag: "BUYER" });
    expect(demote.status).toBe(403);

    // Non-tag edits on a VIP party are fine for staff.
    const notes = await request(app).patch(`/api/parties/${created.body.id}`).set(auth(sales.token)).send({ notes: "Prefers morning calls", ownerStaff: "Rohit" });
    expect(notes.status).toBe(200);
    expect(notes.body.tag).toBe("BUYER_TOP");
    expect(notes.body.ownerStaff).toBe("Rohit");
  });

  it("family contacts are invisible to everyone but the Owner", async () => {
    const family = await request(app).post("/api/parties").set(auth(owner.token)).send({ name: "Bhaiya", tag: "VIP_FAMILY", phones: [{ phone: "9810000003" }] });
    expect(family.status).toBe(201);

    const list = await request(app).get("/api/parties").set(auth(sales.token));
    expect(list.status).toBe(200);
    expect(list.body.some((p: any) => p.id === family.body.id)).toBe(false);

    const byTag = await request(app).get("/api/parties?tag=VIP_FAMILY").set(auth(sales.token));
    expect(byTag.body).toEqual([]);

    const byPhone = await request(app).get("/api/parties?q=9810000003").set(auth(sales.token));
    expect(byPhone.body).toEqual([]);

    expect((await request(app).get(`/api/parties/${family.body.id}`).set(auth(sales.token))).status).toBe(404);
    expect((await request(app).patch(`/api/parties/${family.body.id}`).set(auth(sales.token)).send({ notes: "x" })).status).toBe(404);

    const ownerView = await request(app).get("/api/parties?q=9810000003").set(auth(owner.token));
    expect(ownerView.body.map((p: any) => p.id)).toEqual([family.body.id]);
  });

  it("is gated by parties.view / parties.edit", async () => {
    expect((await request(app).get("/api/parties").set(auth(warehouse.token))).status).toBe(403);

    const stripped = await createUser("SALES");
    await prisma.userPermission.deleteMany({ where: { userId: stripped.user.id, permission: "parties.edit" } });
    expect((await request(app).get("/api/parties").set(auth(stripped.token))).status).toBe(200);
    expect((await request(app).post("/api/parties").set(auth(stripped.token)).send({ name: "X", phones: [{ phone: "9810000099" }] })).status).toBe(403);
    expect((await request(app).post("/api/parties/import").set(auth(stripped.token)).send({ rows: [{ name: "X", phone: "9810000099" }] })).status).toBe(403);
  });

  it("imports the contact sheet: creates, updates on re-import by phone, and reports bad rows individually", async () => {
    const first = await request(app)
      .post("/api/parties/import")
      .set(auth(sales.token))
      .send({
        rows: [
          { Name: "Gupta Traders", Tag: "vendor", Phone: "9810000010", "Owner Staff": "Vikram", "Voice Only": "no" },
          { Name: "Ramesh driver", Tag: "transport", Phone: "9810000011", Phone2: "9810000012", "Voice only": "haan" },
          { Name: "", Phone: "9810000013" },
          { Name: "Weird", Tag: "customer", Phone: "9810000014" },
          { Name: "Bad phone", Phone: "123" },
          { Name: "Bank RM", Tag: "VIP-FINANCE", Phone: "9810000015" },
        ],
      });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: 2, updated: 0, errors: 4 });
    expect(first.body.results.filter((r: any) => r.status === "error").map((r: any) => r.row)).toEqual([3, 4, 5, 6]);

    const driver = await prisma.partyPhone.findUnique({ where: { phone: "+919810000012" }, include: { party: true } });
    expect(driver?.party).toMatchObject({ name: "Ramesh driver", tag: "TRANSPORT", voiceOnly: true });

    const second = await request(app)
      .post("/api/parties/import")
      .set(auth(sales.token))
      .send({ rows: [{ name: "Gupta Traders & Sons", tag: "VENDOR", phone: "09810000010", phone2: "9810000016" }] });
    expect(second.body).toMatchObject({ created: 0, updated: 1, errors: 0 });
    const gupta = await prisma.party.findUnique({ where: { id: second.body.results[0].partyId }, include: { phones: true } });
    expect(gupta?.name).toBe("Gupta Traders & Sons");
    expect(gupta?.ownerStaff).toBe("Vikram"); // blank cell keeps the existing value
    expect(gupta?.phones.map((p) => p.phone).sort()).toEqual(["+919810000010", "+919810000016"]);

    // Owner can import VIP tags.
    const ownerImport = await request(app).post("/api/parties/import").set(auth(owner.token)).send({ rows: [{ name: "Bank RM", tag: "VIP_FINANCE", phone: "9810000015" }] });
    expect(ownerImport.body).toMatchObject({ created: 1, errors: 0 });
  });
});

describe("orders ↔ parties", () => {
  it("auto-links a new order to the party whose phone matches the buyer contact", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Mukesh", buyerContact: "+91 98100-00001", lines: [{ skuId, qtyRequested: 2 }] });
    expect(res.status).toBe(201);
    const party = await prisma.partyPhone.findUnique({ where: { phone: "+919810000001" } });
    expect(res.body.partyId).toBe(party!.partyId);
  });

  it("an explicit partyId must be one the user can see", async () => {
    const family = await prisma.partyPhone.findUnique({ where: { phone: "+919810000003" } });
    const denied = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "X", partyId: family!.partyId, lines: [{ skuId, qtyRequested: 1 }] });
    expect(denied.status).toBe(404);

    const unknownContact = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Walk-in", buyerContact: "9899999999", lines: [{ skuId, qtyRequested: 1 }] });
    expect(unknownContact.status).toBe(201);
    expect(unknownContact.body.partyId).toBeNull();

    const gupta = await prisma.partyPhone.findUnique({ where: { phone: "+919810000010" } });
    const linked = await request(app).patch(`/api/orders/${unknownContact.body.id}`).set(auth(sales.token)).send({ partyId: gupta!.partyId });
    expect(linked.status).toBe(200);
    expect(linked.body.partyId).toBe(gupta!.partyId);
  });
});

describe("call-desk caller lookup (integration token)", () => {
  let token: string;
  let tokenId: string;

  it("only the Owner can create tokens; the plaintext is returned once and only its hash is stored", async () => {
    expect((await request(app).post("/api/integration-tokens").set(auth(sales.token)).send({ name: "Exotel" })).status).toBe(403);

    const res = await request(app).post("/api/integration-tokens").set(auth(owner.token)).send({ name: "Exotel" });
    expect(res.status).toBe(201);
    expect(res.body.scopes).toEqual(["party.lookup"]);
    token = res.body.token;
    tokenId = res.body.id;

    const row = await prisma.integrationToken.findUnique({ where: { id: tokenId } });
    expect(row!.tokenHash).toBe(hashIntegrationToken(token));
    expect(row!.tokenHash).not.toContain(token);

    const list = await request(app).get("/api/integration-tokens").set(auth(owner.token));
    expect(list.body[0]).not.toHaveProperty("token");
    expect(list.body[0]).not.toHaveProperty("tokenHash");
  });

  it("rejects requests without a valid token, including a user session token", async () => {
    expect((await request(app).get("/api/integration/lookup?phone=9810000001")).status).toBe(401);
    expect((await request(app).get("/api/integration/lookup?phone=9810000001").set(auth(owner.token))).status).toBe(401);
    expect((await request(app).get("/api/integration/lookup?phone=9810000001").set("x-integration-token", "oms_int_wrong")).status).toBe(401);
  });

  it("returns who is calling and their recent order statuses — never drafts, never prices", async () => {
    const mukesh = await prisma.partyPhone.findUnique({ where: { phone: "+919810000001" } });
    const orders = await prisma.order.findMany({ where: { partyId: mukesh!.partyId } });
    expect(orders.length).toBe(1);
    await prisma.order.update({ where: { id: orders[0].id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    // A draft for the same party must not appear.
    await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Mukesh", partyId: mukesh!.partyId, lines: [{ skuId, qtyRequested: 1 }] });

    // Telephony providers send caller IDs in assorted formats.
    const res = await request(app).get("/api/integration/lookup").query({ phone: "09810000001" }).set("x-integration-token", token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: "+919810000001", found: true, party: { name: "Mukesh", tag: "LEAD", recordCalls: true } });
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({ orderNumber: orders[0].orderNumber, status: "FINALIZED", lineCount: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/price|amount|cost/i);

    const unknown = await request(app).get("/api/integration/lookup?phone=9899999999").set("x-integration-token", token);
    expect(unknown.body).toEqual({ phone: "+919899999999", found: false });

    expect((await request(app).get("/api/integration/lookup?phone=12").set("x-integration-token", token)).status).toBe(400);

    const used = await prisma.integrationToken.findUnique({ where: { id: tokenId } });
    expect(used!.lastUsedAt).not.toBeNull();
  });

  it("family calls are always flagged as not-to-be-recorded", async () => {
    const res = await request(app).get("/api/integration/lookup?phone=9810000003").set("x-integration-token", token);
    expect(res.body.party).toMatchObject({ tag: "VIP_FAMILY", recordCalls: false });
  });

  it("a revoked token stops working immediately", async () => {
    const revoke = await request(app).post(`/api/integration-tokens/${tokenId}/revoke`).set(auth(owner.token));
    expect(revoke.status).toBe(200);
    expect(revoke.body.revokedAt).not.toBeNull();
    expect((await request(app).get("/api/integration/lookup?phone=9810000001").set("x-integration-token", token)).status).toBe(401);
  });
});
