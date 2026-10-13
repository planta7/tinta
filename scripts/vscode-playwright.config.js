import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/vscode",
  testMatch: ["preview.browser.mjs", "installed-ui.browser.mjs"],
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: "reports/verification/vscode-browser-results.json" },
    ],
  ],
  use: { browserName: "chromium" },
});
