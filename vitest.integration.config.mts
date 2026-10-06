import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the integration tests. These read .env.local and query the live project.
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
