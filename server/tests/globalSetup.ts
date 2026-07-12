import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "..");
const dbPath = path.resolve(rootDir, "prisma/test.db");

export default async function globalSetup() {
  for (const f of [dbPath, `${dbPath}-journal`]) {
    if (existsSync(f)) rmSync(f);
  }
  execSync("npx prisma migrate deploy", {
    cwd: rootDir,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "inherit",
  });
}
