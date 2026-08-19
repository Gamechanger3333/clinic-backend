import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts on purpose: the main config stubs Prisma
// (see src/__tests__/setup.ts) so the fast unit/security suite never needs
// a live database. These integration tests need the OPPOSITE — a real,
// disposable Postgres reachable via DATABASE_URL — so they get their own
// config with no mock setupFiles, and their own npm script (`npm run
// test:integration`) so they're never accidentally pulled into `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 20000,
    include: ["src/__tests__/integration/**/*.test.ts"],
  },
});
