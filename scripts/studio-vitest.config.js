import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/studio.test.mjs",
      "tests/unit/studio-worker.test.mjs",
    ],
    coverage: {
      provider: "v8",
      include: ["apps/studio/dist/*.js"],
      exclude: ["apps/studio/dist/studio-runtime.js"],
      reportsDirectory: "reports/verification/studio-unit-coverage",
      reporter: ["json"],
    },
  },
});
