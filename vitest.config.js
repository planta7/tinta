import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.mjs"],
    reporters: [
      "default",
      ["json", { outputFile: "reports/verification/unit-results.json" }],
    ],
    coverage: {
      provider: "v8",
      include: [
        "scripts/architecture.mjs",
        "scripts/packaging.mjs",
        "scripts/capabilities.mjs",
        "packages/syntax/dist/**/*.js",
        "packages/engine/dist/**/*.js",
        "packages/charts/dist/**/*.js",
        "packages/artifacts/dist/**/*.js",
        "packages/cli/dist/**/*.js",
        "packages/types/dist/**/*.js",
      ],
      exclude: [
        "packages/syntax/dist/registry.js",
        "packages/engine/dist/registry.js",
        "packages/engine/dist/program-validator.js",
        "packages/artifacts/dist/runtime-data.js",
      ],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
        "packages/artifacts/dist/**": {
          statements: 90,
          branches: 85,
          lines: 90,
        },
        "packages/types/dist/**": { statements: 90, branches: 85, lines: 90 },
        "packages/cli/dist/**": { statements: 85, branches: 80, lines: 85 },
        "packages/charts/dist/**": {
          statements: 90,
          branches: 85,
          lines: 90,
        },
        "packages/engine/dist/**": {
          statements: 95,
          branches: 90,
          lines: 95,
        },
        "packages/syntax/dist/**": {
          statements: 95,
          branches: 90,
          lines: 95,
        },
      },
    },
  },
});
