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
      ],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
