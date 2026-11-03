import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { NODE_ENV: "test" },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
