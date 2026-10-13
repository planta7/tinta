import vscodeConfig from "./scripts/vscode-vitest.config.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: vscodeConfig.resolve,
  test: {
    include: ["tests/unit/**/*.test.mjs", "tests/vscode/*.native.mjs"],
    reporters: [
      "default",
      ["json", { outputFile: "reports/verification/unit-results.json" }],
    ],
    coverage: {
      provider: "v8",
      include: [
        ...vscodeConfig.test.coverage.include,
        "apps/studio/dist/worker.js",
        "scripts/architecture.mjs",
        "scripts/packaging.mjs",
        "scripts/capabilities.mjs",
        "packages/syntax/dist/**/*.js",
        "packages/engine/dist/**/*.js",
        "packages/language-service/dist/**/*.js",
        "packages/charts/dist/**/*.js",
        "packages/artifacts/dist/**/*.js",
        "packages/cli/dist/**/*.js",
        "packages/local-files/dist/**/*.js",
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
        "apps/vscode/dist/**": {
          statements: 85,
          functions: 85,
          lines: 85,
          branches: 80,
        },
        "packages/language-server/dist/**": {
          statements: 85,
          functions: 85,
          lines: 85,
          branches: 80,
        },
        "packages/artifacts/dist/**": {
          statements: 90,
          branches: 85,
          lines: 90,
        },
        "packages/types/dist/**": { statements: 90, branches: 85, lines: 90 },
        "packages/cli/dist/**": { statements: 85, branches: 80, lines: 85 },
        "packages/local-files/dist/**": {
          statements: 85,
          branches: 80,
          lines: 85,
        },
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
        "packages/language-service/dist/**": {
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
