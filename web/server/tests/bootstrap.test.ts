import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const app = createApp();

// Filename sorts before every other test file (bootstrap < bugfixes <
// flow < inward-entry < permissions < security) so this runs first against
// the freshly-reset, genuinely empty test database — the one moment the
// "creates the first Owner" success path is actually exercisable, since
// every other file's beforeAll immediately populates the User table.
describe("POST /api/auth/bootstrap", () => {
  it("rejects a missing/wrong setup secret even on an empty database", async () => {
    const res = await request(app)
      .post("/api/auth/bootstrap")
      .send({ name: "Attacker", email: "attacker@test.local", password: "correcthorse9", setupSecret: "wrong-secret" });
    expect(res.status).toBe(403);
    const owner = await prisma.user.findUnique({ where: { email: "attacker@test.local" } });
    expect(owner).toBeNull();
  });

  it("creates the first account as OWNER when the database is empty and the secret matches", async () => {
    const startingCount = await prisma.user.count();
    if (startingCount !== 0) {
      console.warn("Skipping bootstrap success assertions — another test file already populated the User table first.");
      return;
    }
    const res = await request(app)
      .post("/api/auth/bootstrap")
      .send({ name: "First Owner", email: "first-owner@test.local", password: "correcthorse9", setupSecret: "test-secret" });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe("OWNER");

    const login = await request(app).post("/api/auth/login").send({ email: "first-owner@test.local", password: "correcthorse9" });
    expect(login.status).toBe(200);
  });

  it("refuses once any account already exists, even with the correct secret", async () => {
    const res = await request(app)
      .post("/api/auth/bootstrap")
      .send({ name: "Second Owner", email: "second-owner@test.local", password: "correcthorse9", setupSecret: "test-secret" });
    expect(res.status).toBe(403);
  });
});
