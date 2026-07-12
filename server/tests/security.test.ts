import { describe, expect, it } from "vitest";
import request from "supertest";
import { generateSync } from "otplib";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("password policy", () => {
  it("rejects a weak password on account creation", async () => {
    const owner = await createUser("OWNER");
    const res = await request(app)
      .post("/api/users")
      .set(auth(owner.token))
      .send({ name: "Weak Pw", email: "weak@test.local", password: "abc123", role: "SALES" });
    expect(res.status).toBe(400);
  });

  it("accepts a compliant password", async () => {
    const owner = await createUser("OWNER");
    const res = await request(app)
      .post("/api/users")
      .set(auth(owner.token))
      .send({ name: "Strong Pw", email: "strong-pw@test.local", password: "correcthorse9", role: "SALES" });
    expect(res.status).toBe(201);
  });
});

describe("session-backed auth: revocation and inactivity take effect immediately", () => {
  it("a revoked session is rejected on the very next request", async () => {
    const user = await createUser("SALES");
    const before = await request(app).get("/api/skus").set(auth(user.token));
    expect(before.status).toBe(200);

    await request(app).post(`/api/sessions/${user.sessionId}/revoke`).set(auth(user.token));

    const after = await request(app).get("/api/skus").set(auth(user.token));
    expect(after.status).toBe(401);
  });

  it("a session idle past the inactivity window is rejected and auto-marked revoked", async () => {
    const user = await createUser("SALES");
    // Simulate 31 minutes of inactivity (window is 30) directly in the DB —
    // faster and more deterministic than actually waiting.
    await prisma.session.update({
      where: { id: user.sessionId },
      data: { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) },
    });

    const res = await request(app).get("/api/skus").set(auth(user.token));
    expect(res.status).toBe(401);

    const session = await prisma.session.findUnique({ where: { id: user.sessionId } });
    expect(session?.revokedAt).toBeTruthy();
  });

  it("an Owner can remotely revoke another user's session", async () => {
    const owner = await createUser("OWNER");
    const target = await createUser("WAREHOUSE");

    const before = await request(app).get("/api/skus").set(auth(target.token));
    expect(before.status).toBe(200);

    const revokeRes = await request(app).post(`/api/sessions/${target.sessionId}/revoke`).set(auth(owner.token));
    expect(revokeRes.status).toBe(200);

    const after = await request(app).get("/api/skus").set(auth(target.token));
    expect(after.status).toBe(401);
  });

  it("a non-Owner cannot revoke someone else's session", async () => {
    const sales = await createUser("SALES");
    const otherSales = await createUser("SALES");

    const res = await request(app).post(`/api/sessions/${otherSales.sessionId}/revoke`).set(auth(sales.token));
    expect(res.status).toBe(403);
  });
});

describe("login audit logging", () => {
  it("logs LOGIN_FAILURE on a wrong password and LOGIN_SUCCESS on a correct one", async () => {
    const owner = await createUser("OWNER");
    const email = `login-audit-${Date.now()}@test.local`;
    const createRes = await request(app)
      .post("/api/users")
      .set(auth(owner.token))
      .send({ name: "Login Audit", email, password: "correcthorse9", role: "SALES" });
    expect(createRes.status).toBe(201);

    const badLogin = await request(app).post("/api/auth/login").send({ email, password: "wrongpassword1" });
    expect(badLogin.status).toBe(401);

    const goodLogin = await request(app).post("/api/auth/login").send({ email, password: "correcthorse9" });
    expect(goodLogin.status).toBe(200);

    const audit = await request(app).get("/api/reports/audit-log?entityType=User").set(auth(owner.token));
    const userId = createRes.body.id;
    const failure = audit.body.find((a: any) => a.action === "LOGIN_FAILURE" && a.entityId === userId);
    const success = audit.body.find((a: any) => a.action === "LOGIN_SUCCESS" && a.entityId === userId);
    expect(failure).toBeTruthy();
    expect(success).toBeTruthy();
  });
});

describe("audit log tamper-evident hash chain", () => {
  it("verifies as intact after normal operation", async () => {
    const owner = await createUser("OWNER");
    const res = await request(app).get("/api/reports/audit-log/verify").set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it("detects tampering when a row is altered directly in the DB", async () => {
    const owner = await createUser("OWNER");
    const anyRow = await prisma.auditLog.findFirst();
    expect(anyRow).toBeTruthy();
    await prisma.auditLog.update({ where: { id: anyRow!.id }, data: { after: '{"tampered":true}' } });

    const res = await request(app).get("/api/reports/audit-log/verify").set(auth(owner.token));
    expect(res.body.valid).toBe(false);
    expect(res.body.brokenAtId).toBeTruthy();
  });
});

describe("field-level encryption at rest", () => {
  it("stores price as an opaque ciphertext, never the plaintext number, but the API still returns the decrypted value", async () => {
    const owner = await createUser("OWNER");
    const sales = await createUser("SALES");
    const sku = await prisma.sku.create({ data: { code: "ENC-TEST-1", name: "Encryption Test", unit: "pc" } });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Enc Buyer", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const lineId = order.body.lines[0].id;

    await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({ lines: [{ lineId, unitPrice: 999.5 }] });

    const rawRow = await prisma.orderLinePrice.findUnique({ where: { orderLineId: lineId } });
    expect(rawRow?.unitPrice).not.toBe("999.5");
    expect(rawRow?.unitPrice).not.toContain("999.5");
    expect(rawRow?.unitPrice.split(".").length).toBe(3); // iv.tag.ciphertext format

    const apiRes = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token));
    expect(apiRes.body.lines[0].unitPrice).toBe(999.5);
  });
});

describe("optional TOTP 2FA", () => {
  it("full enroll -> confirm -> login-requires-code -> login-with-code flow", async () => {
    const owner = await createUser("OWNER");
    const email = `totp-user-${Date.now()}@test.local`;
    const createRes = await request(app)
      .post("/api/users")
      .set(auth(owner.token))
      .send({ name: "Totp User", email, password: "correcthorse9", role: "ACCOUNTANT" });
    const loginRes = await request(app).post("/api/auth/login").send({ email, password: "correcthorse9" });
    const userToken = loginRes.body.token;

    const enrollRes = await request(app).post("/api/auth/2fa/enroll").set(auth(userToken));
    expect(enrollRes.status).toBe(200);
    const secret = enrollRes.body.secret;

    const validCode = generateTotpForTest(secret);
    const confirmRes = await request(app).post("/api/auth/2fa/confirm").set(auth(userToken)).send({ code: validCode });
    expect(confirmRes.status).toBe(200);

    const loginWithoutCode = await request(app).post("/api/auth/login").send({ email, password: "correcthorse9" });
    expect(loginWithoutCode.status).toBe(401);
    expect(loginWithoutCode.body.requiresTotp).toBe(true);

    const freshCode = generateTotpForTest(secret);
    const loginWithCode = await request(app).post("/api/auth/login").send({ email, password: "correcthorse9", totpCode: freshCode });
    expect(loginWithCode.status).toBe(200);
    expect(loginWithCode.body.user.totpEnabled).toBe(true);
  });
});

function generateTotpForTest(secret: string): string {
  return generateSync({ secret });
}

// Placed last: it deliberately exhausts the login rate limiter, which would
// otherwise cause every subsequent login attempt in this file (same app
// instance, same client IP) to fail with 429 instead of the status each
// test actually means to exercise.
describe("login rate limiting", () => {
  it("blocks further login attempts after repeated failures from the same client", async () => {
    const email = `rate-limit-${Date.now()}@test.local`;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password: "wrongpassword1" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
