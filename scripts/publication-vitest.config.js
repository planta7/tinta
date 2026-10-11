import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/publication*.test.mjs",
      "tests/publication/*.test.mjs",
    ],
    testTimeout: 30000,
  },
});
