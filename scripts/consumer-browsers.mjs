import { chromium, firefox, webkit, expect } from "@playwright/test";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readFile,
  writeFile,
  copyFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";

async function staticDirectory(root) {
  const files = new Map();
  for (const name of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!name.isFile()) continue;
    const path = join(name.parentPath, name.name);
    files.set(
      "/nested/" + relative(root, path).split(sep).join("/"),
      await readFile(path),
    );
  }
  const server = createServer((request, response) => {
    const bytes = files.get(request.url);
    if (!bytes || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const type = request.url.endsWith(".js")
      ? "text/javascript"
      : request.url.endsWith(".css")
        ? "text/css"
        : "text/html";
    response.writeHead(200, { "content-type": type });
    response.end(bytes);
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((accept) => {
        server.closeAllConnections();
        server.close(accept);
      }),
  };
}

export async function testConsumerBrowsers(temporary) {
  const results = [];
  for (const manager of ["npm", "pnpm"]) {
    const root = join(temporary, manager);
    await copyFile(
      new URL("../tests/consumer/browser.mjs", import.meta.url),
      join(root, "browser.mjs"),
    );
    const built = await build({
      absWorkingDir: root,
      entryPoints: ["browser.mjs"],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "TintaConsumer",
      write: false,
      metafile: true,
    });
    for (const path of Object.keys(built.metafile.inputs)) {
      const rel = relative(root, resolve(root, path));
      expect(rel.startsWith(`..${sep}`)).toBe(false);
    }
    await writeFile(join(root, "browser.js"), built.outputFiles[0].contents);
  }
  const staticHost = await staticDirectory(
    join(temporary, "downloads/studio-directory"),
  );
  try {
    for (const [name, launcher] of Object.entries({
      chromium,
      firefox,
      webkit,
    })) {
      const browserHome = join(temporary, `browser-${name}`);
      await mkdir(browserHome, { recursive: true });
      const browser = await launcher.launch({
        proxy: {
          server: "http://127.0.0.1:9",
          bypass: "127.0.0.1",
        },
        ...(name === "firefox"
          ? {
              env: {
                ...process.env,
                MOZ_APP_DATA: browserHome,
                MOZ_LOCAL_APP_DATA: browserHome,
              },
            }
          : {}),
      });
      const context = await browser.newContext({ offline: true });
      const page = await context.newPage();
      const errors = [];
      const offlineRequests = [];
      context.on("request", (request) => {
        if (/^https?:/.test(request.url())) offlineRequests.push(request.url());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        for (const manager of ["npm", "pnpm"]) {
          for (const format of ["static", "interactive"]) {
            await page.goto(
              pathToFileURL(join(temporary, manager, `${format}.html`)).href,
            );
            await expect(page.locator("body")).toContainText("Value: 2");
            await expect(
              page.getByRole("img", { name: "Photo" }),
            ).toBeVisible();
            if (format === "interactive") {
              const slider = page.getByRole("slider", { name: "Amount" });
              await expect(slider).toHaveValue("2");
              await slider.focus();
              await slider.press("ArrowRight");
              await expect(page.locator("body")).toContainText("Value: 3");
            } else await expect(page.getByRole("slider")).toHaveCount(0);
          }
          const installed = await readFile(
            join(temporary, manager, "tinta-studio.html"),
          );
          const standalone = await readFile(
            join(temporary, "downloads/studio-standalone/tinta-studio.html"),
          );
          expect(installed.equals(standalone)).toBe(true);
          for (const standaloneReader of [false, true]) {
            const integration = await context.newPage();
            integration.on("pageerror", (error) => errors.push(error.message));
            await integration.addScriptTag({
              path: join(temporary, manager, "browser.js"),
            });
            await integration.addScriptTag({
              path: join(temporary, "downloads/reader-runtime/reader.js"),
            });
            await integration.addStyleTag({
              path: join(temporary, "downloads/reader-runtime/reader.css"),
            });
            await integration.evaluate((standalone) => {
              globalThis.consumerCleanup = globalThis.TintaConsumer.mount(
                document.body,
                standalone
                  ? globalThis.TintaReaderRuntime.TintaReader.mountReader
                  : undefined,
              );
            }, standaloneReader);
            await expect(integration.locator("svg")).toBeVisible();
            const slider = integration.getByRole("slider", { name: "Amount" });
            await slider.focus();
            await slider.press("ArrowRight");
            await expect(integration.locator("body")).toContainText("Value: 3");
            await integration.evaluate(() => globalThis.consumerCleanup());
            await integration.close();
          }
        }
        await page.goto(
          pathToFileURL(
            join(
              temporary,
              "downloads/examples/article.tinta.interactive.html",
            ),
          ).href,
        );
        await expect(page.locator(".tinta-reader")).toBeVisible();
        await page.goto(
          pathToFileURL(
            join(temporary, "downloads/studio-standalone/tinta-studio.html"),
          ).href,
        );
        await exerciseStudio(page);
        const local = await browser.newContext();
        const blocked = [];
        // WebKit interception disrupts local Blob workers. The browser's dead
        // loopback proxy blocks nonlocal HTTP; observation still rejects attempts.
        local.on("request", (request) => {
          const url = request.url();
          if (/^https?:/.test(url) && !url.startsWith(staticHost.origin + "/"))
            blocked.push(url);
        });
        const staticPage = await local.newPage();
        staticPage.on("pageerror", (error) => errors.push(error.message));
        await staticPage.goto(staticHost.origin + "/nested/index.html");
        try {
          await exerciseStudio(staticPage);
        } catch (error) {
          throw new Error(
            JSON.stringify({
              browser: name,
              error: String(error),
              blocked,
              errors,
              body: await staticPage.locator("body").innerText(),
            }),
            { cause: error },
          );
        }
        expect(blocked).toEqual([]);
        expect(errors).toEqual([]);
        expect(offlineRequests).toEqual([]);
        results.push({
          browser: name,
          version: browser.version(),
          status: "PASS",
          checks: [
            "npm/pnpm exports at file origin offline",
            "installed reader and charts",
            "standalone reader JS/CSS",
            "example HTML",
            "standalone Studio offline",
            "directory Studio nested relative resources on loopback only",
          ],
        });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await staticHost.close();
  }
  return results;
}

async function exerciseStudio(page) {
  await page
    .getByRole("button", { name: "Explore examples", exact: true })
    .click();
  await page.getByRole("button", { name: "guide", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await expect(page.frameLocator("iframe").getByRole("article")).toBeVisible();
}
