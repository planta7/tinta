import { preview } from "vite";
import { resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { test, expect } from "./fixtures.mjs";

test("chunked Studio preserves module initialization and embedded runtimes", async ({
  page,
}) => {
  const server = await preview({
    root: resolve("apps/studio"),
    configFile: resolve("apps/studio/vite.config.js"),
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  try {
    const directory = "build/studio/assets";
    const chunks = (await readdir(directory)).filter((name) =>
      name.endsWith(".js"),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const name of chunks) {
      expect((await stat(resolve(directory, name))).size).toBeLessThan(
        500 * 1000,
      );
    }

    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page
      .getByRole("button", { name: "Explore examples", exact: true })
      .click();
    await page.getByRole("button", { name: "guide", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeEnabled();
    await page
      .frameLocator("iframe")
      .getByLabel("Your platform")
      .selectOption("Linux");
    await expect(
      page.frameLocator("iframe").getByRole("article"),
    ).toContainText("Linux");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Document source" })
      .fill('# Chunked build\n\n@slider amount = 5 (label: "Amount")\n');
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("heading", { name: "Chunked build" }),
    ).toBeVisible();
    await expect(page.frameLocator("iframe").getByLabel("Amount")).toHaveValue(
      "5",
    );
    expect(errors).toEqual([]);
  } finally {
    await new Promise((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
