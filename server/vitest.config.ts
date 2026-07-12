import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(dirname, "prisma/test.db");

export default defineConfig({
  test: {
    globalSetup: "./tests/globalSetup.ts",
    env: {
      DATABASE_URL: `file:${testDbPath}`,
      JWT_SECRET: "test-secret",
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
