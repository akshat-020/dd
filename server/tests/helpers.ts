import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma.js";
import { signToken } from "../src/lib/jwt.js";
import type { Role } from "../src/lib/roles.js";

let counter = 0;

export async function createUser(role: Role) {
  counter += 1;
  // Each test file gets its own module registry (fresh `counter`), but they
  // all share the same test.db, so a random suffix avoids cross-file email
  // collisions on the unique constraint.
  const email = `${role.toLowerCase()}-${counter}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const passwordHash = await bcrypt.hash("password123", 4);
  const user = await prisma.user.create({ data: { name: `${role} Test`, email, passwordHash, role } });
  const token = signToken({ sub: user.id, role, name: user.name });
  return { user, token };
}
