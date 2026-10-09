import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./scripts/browser-coverage-setup.mjs",
  globalTeardown: "./scripts/browser-coverage.mjs",
  forbidOnly: true,
  workers: 2,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "reports/verification/browser-results.json" }],
  ],
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
});
