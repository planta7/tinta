import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
export async function chooseInstalledPath(page, title, path) {
  const dialog = page.locator(".quick-input-widget");
  await dialog.getByText(title, { exact: true }).waitFor();
  // The input is visible before the initial directory listing has loaded.
  // That initial load can overwrite a path entered before it finishes.
  await dialog.getByRole("option", { name: "..", exact: true }).waitFor();
  const input = dialog.locator("input[type=text]");
  await input.fill(path);
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
}

export async function driveInstalledUI(root, port, signal) {
  let browser;
  for (let attempt = 0; attempt < 100 && !signal.aborted; attempt++) {
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`)
      .catch(() => null);
    if (browser) break;
    await delay(100);
  }
  if (!browser) throw new Error("Desktop debugging endpoint did not start.");
  let last = 0;
  while (!signal.aborted) {
    const request = await readFile(join(root, "ui-request.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!request || request.id <= last) {
      await delay(50);
      continue;
    }
    last = request.id;
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("workbench"));
    const response = { id: request.id };
    try {
      assert.ok(page, "No native workbench page.");
      page.setDefaultTimeout(15000);
      if (request.action === "enrich") {
        await page
          .getByRole("button", {
            name: "Create Separate Document",
            exact: true,
          })
          .click();
      } else if (request.action === "root") {
        await chooseInstalledPath(
          page,
          "Select this document's local image root",
          request.path + "/",
        );
      } else if (request.action === "controls") {
        let inner;
        for (let index = 0; index < 150; index++) {
          for (const context of browser.contexts())
            for (const surface of context.pages())
              for (const frame of surface.frames())
                if (await frame.getByRole("slider", { name: "Amount" }).count())
                  inner = frame;
          if (inner) break;
          await delay(100);
        }
        assert.ok(inner, "No installed preview control.");
        await inner.getByRole("slider", { name: "Amount" }).focus();
        await inner.getByRole("slider", { name: "Amount" }).press("ArrowRight");
        await inner.getByText("Value: 3", { exact: true }).waitFor();
        assert.ok(await inner.locator("svg").count());
        assert.ok(await inner.locator("img").count());
        const inspector = inner.getByRole("slider", {
          name: "Inspect data point",
        });
        await inspector.focus();
        await inspector.press("ArrowRight");
        await inner
          .getByText("name: B; value: 5; 2 of 2", { exact: true })
          .waitFor();
        await page.screenshot({ path: join(root, "installed-preview.png") });
      } else if (request.action === "export") {
        await page
          .getByText("Current preview answers", { exact: true })
          .click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        await chooseInstalledPath(page, "Export HTML", request.path);
      } else if (request.action === "offline") {
        const offline = await chromium.launch({ headless: true });
        try {
          const context = await offline.newContext({ offline: true });
          const opened = await context.newPage();
          const unexpected = [];
          opened.on("request", (request) => {
            if (/^https?:/.test(request.url())) unexpected.push(request.url());
          });
          for (const name of ["static.html", "interactive.html"]) {
            await opened.goto(
              pathToFileURL(join(request.directory, name)).href,
            );
            await opened.getByText("Value: 3", { exact: true }).waitFor();
            assert.ok(await opened.locator("svg").count());
            if (name === "interactive.html") {
              const slider = opened.getByRole("slider", { name: "Amount" });
              await slider.focus();
              await slider.press("ArrowRight");
              await opened.getByText("Value: 4", { exact: true }).waitFor();
            }
          }
          assert.deepEqual(unexpected, []);
        } finally {
          await offline.close();
        }
      } else throw new Error("Unknown installed UI action.");
    } catch (error) {
      response.error = String(error.stack ?? error);
      if (page) {
        await page
          .screenshot({ path: join(root, `ui-failure-${request.id}.png`) })
          .catch(() => {});
        await writeFile(
          join(root, `ui-failure-${request.id}.txt`),
          await page.locator("body").innerText(),
        ).catch(() => {});
      }
    }
    await writeFile(join(root, "ui-response.json"), JSON.stringify(response));
  }
}
