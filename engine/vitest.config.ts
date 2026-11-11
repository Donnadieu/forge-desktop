import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Stand-in agents never answer the thinking probe; asking each one would add seconds to every agent test.
    env: { NODE_ENV: "test", FORGE_THINKING_DISPLAY: "off" },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
