import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/studio*.test.mjs",
      "tests/unit/cli*.test.mjs",
      "tests/unit/editor-*.test.mjs",
      "tests/unit/preview-build.test.mjs",
      "tests/unit/authoring-skill.test.mjs",
      "tests/unit/diagnostic-contract.test.mjs",
      "tests/unit/document-integrity.test.mjs",
      "tests/unit/resource-boundaries.test.mjs",
      "tests/unit/incident-diagnostics.test.mjs",
    ],
    coverage: {
      provider: "v8",
      include: ["apps/studio/dist/worker.js", "packages/cli/dist/**/*.js"],
      exclude: ["apps/studio/dist/studio-runtime.js"],
      reportsDirectory: "coverage",
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
      reporter: ["json"],
    },
  },
});
