import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(dirname, "prisma/test.db");

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
      DATABASE_URL: `file:${testDbPath}`,
      JWT_SECRET: "test-secret",
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
