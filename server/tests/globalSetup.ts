import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "..");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:localdev@localhost:5432/oms_erp_test";

export default async function globalSetup() {
  // Drops and recreates the test database's schema, then reapplies every
  // migration from scratch — same effect as deleting the old SQLite test.db
  // file had, just for a Postgres database instead of a file on disk.
  execSync("npx prisma migrate reset --force --skip-generate --skip-seed", {
    cwd: rootDir,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
}
