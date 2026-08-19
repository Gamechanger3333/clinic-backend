/**
 * src/test/setup.ts — runs before every test file (see vitest.config.ts).
 *
 * lib/auth.ts validates ACCESS_TOKEN_SECRET/REFRESH_TOKEN_SECRET at import
 * time (see the review note there about failing fast on a missing/weak
 * secret) — so these have to exist BEFORE anything under src/ is imported,
 * which is why this file is a `setupFiles` entry rather than a per-test
 * beforeAll().
 */
process.env.NODE_ENV = "test";
process.env.ACCESS_TOKEN_SECRET  ??= "test-access-token-secret-at-least-32-chars-long";
process.env.REFRESH_TOKEN_SECRET ??= "test-refresh-token-secret-at-least-32-chars-long";
process.env.ACCESS_TOKEN_EXPIRES_IN  ??= "15m";
process.env.REFRESH_TOKEN_EXPIRES_IN ??= "7d";
process.env.FRONTEND_URL ??= "http://localhost:3000";
process.env.PORT ??= "3999";
