import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 10000,
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/__tests__/integration/**"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
