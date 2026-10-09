import { test as base, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { expect };

export const test = base.extend({
  launchOptions: async ({ browserName, launchOptions }, use) => {
    if (browserName !== "firefox") {
      await use(launchOptions);
      return;
    }

    // Firefox resolves application data separately from Playwright's profile.
    // Keep test bookkeeping away from the user's personal browser data.
    const root = await mkdtemp(join(tmpdir(), "tinta-firefox-"));

    try {
      const appData = join(root, "app-data");
      const localData = join(root, "local-data");
      await Promise.all([mkdir(appData), mkdir(localData)]);

      await use({
        ...launchOptions,
        env: {
          ...process.env,
          ...launchOptions.env,
          MOZ_APP_DATA: appData,
          MOZ_LOCAL_APP_DATA: localData,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

export async function studioAction(page, name, options = {}) {
  const groups = {
    Home: "File",
    New: "File",
    Open: "File",
    "Save source as": "File",
    "Save bundle": "File",
    Import: "Insert",
    Snippets: "Insert",
    Check: "Tools",
    "Reset reading": "Tools",
    Examples: "Tools",
    Recovery: "Tools",
  };
  const menu = page.locator(".action-menu").filter({
    has: page.locator("summary").getByText(groups[name], { exact: true }),
  });
  if (!(await menu.evaluate((element) => element.open))) {
    await menu.locator("summary").click(options);
  }
  await page.getByRole("button", { name, exact: true }).click(options);
}
