import { defineConfig } from "vitest/config";

// A dedicated Postgres database (not oms_erp_dev) so running tests can
// never touch dev data. Override via TEST_DATABASE_URL if the local/CI
// Postgres instance uses different credentials than the devcontainer's.
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:localdev@localhost:5432/oms_erp_test";

export default defineConfig({
  test: {
    globalSetup: "./tests/globalSetup.ts",
    // Explicitly loaded rather than relying on Prisma Client's constructor
    // having the side effect of loading .env — that only happens to work
    // for test files that happen to import prisma.ts before anything else
    // that reads process.env, which is a fragile thing to depend on
    // implicitly.
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: "test-secret",
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
