import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests hit the live Supabase project, so they are excluded here:
    // `npm test` must stay fast and work with no network and no secrets.
    // Run them deliberately with `npm run test:integration`.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
