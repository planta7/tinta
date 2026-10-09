import { build } from "esbuild";
import AxeBuilder from "@axe-core/playwright";
import { readerCoverage } from "../../scripts/reader-coverage.mjs";
import { readFile } from "node:fs/promises";
import { test, expect, studioAction } from "./fixtures.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const url = pathToFileURL(resolve("build/tinta-studio.html")).href;

const coverage = [];
const runtimes = new Map();

test.beforeAll(async ({ browserName }) => {
  if (browserName !== "chromium") return;
  for (const name of ["index", "preview"]) {
    const path = resolve("build/studio-coverage", name + ".js");
    await build({
      entryPoints: ["apps/studio/dist/" + name + ".js"],
      outfile: path,
      bundle: true,
      minify: name === "preview",
      format: "iife",
      platform: "browser",
      target: "es2022",
      define: { "process.env.NODE_ENV": '"production"' },
      sourcemap: "external",
    });
    const code = (await readFile(path, "utf8"))
      .replace(/<\/script/gi, "<\\/script")
      .replace(/<!--/g, "<\\!--");
    runtimes.set(name, { path, code });
  }
});

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
});

test.afterEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    coverage.push(...(await page.coverage.stopJSCoverage()));
});

test.afterAll(async ({ browserName }) => {
  if (browserName !== "chromium") return;
  for (const [name, runtime] of runtimes) {
    await readerCoverage(
      coverage
        .filter((entry) => entry.source?.startsWith(runtime.code))
        .map((entry) => ({ ...entry, url: pathToFileURL(runtime.path).href })),
      runtime.path + ".map",
      {
        sourceRoot: "apps/studio/dist",
        sources:
          name === "index"
            ? [
                "index.js",
                "compiler-host.js",
                "editor.js",
                "files.js",
                "model.js",
                "preview-host.js",
                "protocol.js",
                "recovery.js",
                "source-buffer.js",
                "studio.js",
                "controls.js",
                "dialogs.js",
                "workspace.js",
                "welcome.js",
                "workspace-header.js",
                "catalog.js",
                "navigation.js",
                "drafts.js",
              ]
            : ["preview.js"],
        report:
          "reports/verification/studio-" +
          (name === "index" ? "browser" : "preview") +
          "-coverage.json",
      },
    );
  }
});

async function example(page, name = "guide") {
  await page.goto(url);
  await page
    .getByRole("button", { name: "Explore examples", exact: true })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await expect(page.frameLocator("iframe").getByRole("article")).toBeVisible();
}

test("standalone reading, sandbox, answers, edit and invalid recovery", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await example(page);
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-popups allow-popups-to-escape-sandbox",
  );
  await page
    .frameLocator("iframe")
    .getByLabel("Your platform")
    .selectOption("Linux");
  await expect(page.locator("header")).not.toContainText("Changed");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill("@slider value = broken\n");
  await expect(page.getByRole("status")).toContainText("last valid source");
  await expect(
    page.frameLocator("iframe").getByLabel("Your platform"),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save source", exact: true }),
  ).toBeEnabled();
  await editor.fill(
    '# Recovered\n\n@toggle enabled = false (label: "Enabled")\n',
  );
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Recovered" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("automatic local drafts restore source and mode after reload", async ({
  page,
}) => {
  await example(page);
  await studioAction(page, "Recovery");
  const enabled = page.getByLabel("Keep local recovery copies on this device");
  await expect(enabled).toBeChecked();
  await enabled.check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.press("ControlOrMeta+End");
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("Recovery marker");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const databases = await indexedDB.databases();
        if (!databases.some((database) => database.name === "tinta-recovery"))
          return false;
        return new Promise((resolve) => {
          const open = indexedDB.open("tinta-recovery", 1);
          open.onsuccess = () => {
            const db = open.result;
            const read = db
              .transaction("copies")
              .objectStore("copies")
              .getAll();
            read.onsuccess = () => {
              resolve(
                read.result.some((copy) =>
                  copy.source.includes("Recovery marker"),
                ),
              );
              db.close();
            };
          };
          open.onerror = () => resolve(false);
        });
      }),
    )
    .toBe(true);
  page.on("dialog", (dialog) => dialog.accept());
  const documentUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(documentUrl);
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("textbox", { name: "Document source" })
    .press("ControlOrMeta+End");
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toContainText("Recovery marker");
});

test("raw Markdown opens inert, preserves bytes, enriches and reports download handoff", async ({
  page,
}) => {
  await page.goto(url);
  const original =
    "\uFEFF# Notes\r\n\r\nLiteral {{ 1 + 2 }}\n@toggle value = false\r\n";
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(original),
  });
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("header")).toContainText("Markdown");
  await expect(page.frameLocator("iframe").getByRole("article")).toContainText(
    "Literal {{ 1 + 2 }}",
  );
  let download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  const file = await download;
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(await file.path(), "utf8")).toBe(original);
  await expect(page.getByRole("status")).toContainText(
    "Source download started — check your browser's Downloads.",
  );
  await page
    .getByRole("button", { name: "Enrich as tinta", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create tinta source", exact: true })
    .click();
  await expect(page.locator("header")).toContainText("notes.tinta");
  await expect(page.locator("header")).toContainText("Changed");
  download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("notes.tinta");
});

test("unsaved dialog close preserves source, file actions and focus", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("# My unsaved draft");
  await studioAction(page, "New");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toHaveText("# My unsaved draft");
  await expect(
    page.locator("summary").filter({ hasText: /^File$/ }),
  ).toBeFocused();
});

test("unknown extensions require a profile and multiple files require a single choice", async ({
  page,
}) => {
  await page.goto(url);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await (
    await chooser
  ).setFiles([
    {
      name: "first.bin",
      mimeType: "text/plain",
      buffer: Buffer.from("# First"),
    },
    {
      name: "second.tinta",
      mimeType: "text/plain",
      buffer: Buffer.from("# Second"),
    },
  ]);
  await page.getByRole("button", { name: "first.bin", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose source profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator("header")).toContainText("first.bin");
  await expect(page.locator("header")).toContainText("Markdown");
});

for (const name of ["article", "report", "guide", "chart-atlas"]) {
  test(`offline example ${name} and responsive reading`, async ({
    page,
  }, info) => {
    const requests = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await example(page, name);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(
      page.getByRole("button", { name: "Source", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Document source" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(
      page.frameLocator("iframe").getByRole("article"),
    ).toBeVisible();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `reports/verification/studio-${info.project.name}-${name}-${width}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(requests).toEqual([]);
  });
}

test("reconciles prose edits and resets a changed initial without changing saved source", async ({
  page,
}) => {
  await example(page);
  const preview = page.frameLocator("iframe");
  await preview.getByLabel("Your platform").selectOption("Linux");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  const original = await readFile("examples/guide.tinta", "utf8");
  await editor.fill(original + "\n\nMore prose.\n");
  await expect(preview.getByLabel("Your platform")).toHaveValue("Linux");
  await editor.fill(
    original.replace(
      '@choice platform = "macOS"',
      '@choice platform = "Windows"',
    ),
  );
  await expect(preview.getByLabel("Your platform")).toHaveValue("Windows");
  await expect(page.getByRole("status")).toContainText(
    "1 answers reset after source changes",
  );
  await preview.getByLabel("Your platform").selectOption("Linux");
  await studioAction(page, "Reset reading");
  await expect(preview.getByLabel("Your platform")).toHaveValue("Windows");
  await expect(page.locator("header")).toContainText("Changed");
});

test("exports selected current answers and validates the downloaded offline reader", async ({
  page,
  context,
}, info) => {
  await example(page);
  await page
    .frameLocator("iframe")
    .getByLabel("Your platform")
    .selectOption("Linux");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("dialog"))
    .toBeVisible()
    .catch(async (error) => {
      console.log(await page.locator("body").innerText());
      throw error;
    });
  await page
    .getByLabel("Answers", { exact: true })
    .selectOption("Current answers");
  await expect(page.getByRole("dialog")).toContainText(
    "Hidden content is not private.",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export file", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("guide.interactive.html");
  const exported = info.outputPath("guide.interactive.html");
  await file.saveAs(exported);
  const reader = await context.newPage();
  await reader.goto(pathToFileURL(exported).href);
  await expect(reader.getByLabel("Your platform")).toHaveValue("Linux");
  await reader.close();
});

test("image import is one source and asset undo transaction", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await studioAction(page, "Import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Local image", exact: true }).click();
  await (
    await chooser
  ).setFiles(
    resolve(
      "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
    ),
  );
  await page
    .getByLabel("Alt text", { exact: true })
    .fill("Imported local raster");
  await page.getByRole("button", { name: "Insert image", exact: true }).click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("img", { name: "Imported local raster" }),
  ).toBeVisible();
  await studioAction(page, "Recovery");
  await page.getByLabel("Keep local recovery copies on this device").check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const storedAssets = () =>
    page.evaluate(async () => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === "tinta-recovery"))
        return -1;
      return new Promise((resolve) => {
        const request = indexedDB.open("tinta-recovery", 1);
        request.onsuccess = () => {
          const database = request.result;
          const copies = database
            .transaction("copies")
            .objectStore("copies")
            .getAll();
          copies.onsuccess = () => {
            resolve(copies.result[0]?.assets.length ?? -1);
            database.close();
          };
        };
        request.onerror = () => resolve(-1);
      });
    });
  await expect.poll(storedAssets).toBe(1);
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("");
  await expect(page.frameLocator("iframe").getByRole("img")).toHaveCount(0);
  await expect.poll(storedAssets).toBe(0);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("img", { name: "Imported local raster" }),
  ).toBeVisible();
  await expect.poll(storedAssets).toBe(1);
  await editor.press("ControlOrMeta+End");
  await editor.press("End");
  await studioAction(page, "Import");
  const repeated = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Local image", exact: true }).click();
  await (
    await repeated
  ).setFiles(
    resolve(
      "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
    ),
  );
  await page.getByLabel("Alt text", { exact: true }).fill("Shared raster");
  await page.getByRole("button", { name: "Insert image", exact: true }).click();
  await expect(page.frameLocator("iframe").getByRole("img")).toHaveCount(2);
  await editor.press("ControlOrMeta+z");
  await expect(page.frameLocator("iframe").getByRole("img")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe").getByRole("img", {
      name: "Imported local raster",
    }),
  ).toBeVisible();
  await expect.poll(storedAssets).toBe(1);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect(page.frameLocator("iframe").getByRole("img")).toHaveCount(2);
  await expect.poll(storedAssets).toBe(1);
});

test("data import previews mappings and inserts after a complete root block", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill('@details "Nested"\nParagraph.\n@end\n');
  await expect(
    page.frameLocator("iframe").locator("summary", { hasText: "Nested" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await studioAction(page, "Import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "CSV data", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "scores.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,Score\nOne,2\nTwo,3\n"),
  });
  await expect(page.getByRole("dialog")).toContainText("root block boundary");
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "@data scores",
  );
  await page.getByRole("button", { name: "Insert data", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  const source = await readFile(await (await download).path(), "utf8");
  expect(source.indexOf("@data scores")).toBeGreaterThan(
    source.indexOf("@end"),
  );
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("@data scores");
});

test("sandbox denies parent authority and ignores unauthenticated messages", async ({
  page,
}) => {
  await example(page);
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame());
  expect(
    await frame.evaluate(() => {
      try {
        return !!parent.document.body;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  expect(
    await frame.evaluate(() => {
      try {
        localStorage.setItem("forbidden", "x");
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  await page.evaluate(() => {
    window.postMessage(
      {
        protocol: "tinta-host-1",
        kind: "state",
        controls: { platform: "Linux" },
      },
      "*",
    );
    document.querySelector("iframe").contentWindow.postMessage(
      {
        protocol: "tinta-host-1",
        kind: "load",
        source: "<script>parent.hacked=true</script>",
      },
      "*",
    );
  });
  await expect(
    page.frameLocator("iframe").getByLabel("Your platform"),
  ).toHaveValue("macOS");
  expect(await page.evaluate(() => "hacked" in window)).toBe(false);
});

test("denied recovery storage leaves source saving available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw new DOMException("Denied", "SecurityError");
      },
    });
  });
  await example(page);
  await studioAction(page, "Recovery");
  await page.getByLabel("Keep local recovery copies on this device").check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "W_RECOVERY_UNAVAILABLE",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("guide.tinta");
});

test("mixed line endings and BOM survive edit, undo and raw source saving", async ({
  page,
}) => {
  await page.goto(url);
  const original = "\uFEFF# Original\r\n\r\nFirst.\nSecond.\rThird.\r\n";
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "mixed.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(original),
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("Added");
  let download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  expect(await readFile(await (await download).path(), "utf8")).toBe(
    original + "Added",
  );
  await editor.press("ControlOrMeta+z");
  download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  expect(await readFile(await (await download).path(), "utf8")).toBe(original);
});

test("bundle and snapshot downloads preserve authored defaults and chosen answers", async ({
  page,
}) => {
  await example(page);
  await page
    .frameLocator("iframe")
    .getByLabel("Your platform")
    .selectOption("Linux");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByLabel("Format", { exact: true })
    .selectOption("Answers snapshot");
  let download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export file", exact: true }).click();
  const snapshot = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(snapshot.controls.platform).toBe("Linux");
  download = page.waitForEvent("download");
  await studioAction(page, "Save bundle");
  const bundle = await download;
  expect(bundle.suggestedFilename()).toBe("guide.tinta.zip");
  const chooser = page.waitForEvent("filechooser");
  await studioAction(page, "Open");
  await (
    await chooser
  ).setFiles({
    name: "guide.tinta.zip",
    mimeType: "application/zip",
    buffer: await readFile(await bundle.path()),
  });
  await expect(
    page.frameLocator("iframe").getByLabel("Your platform"),
  ).toHaveValue("macOS");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByLabel("Format", { exact: true }).selectOption("Static HTML");
  download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export file", exact: true }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect(html).not.toContain("<script");
  expect(html).not.toContain(
    "Open the local HTML file in a browser from File Explorer.",
  );
});

test("source save-as, keyboard commands and unsaved Save or Discard", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("# Changed");
  await studioAction(page, "Save source as");
  await page.getByLabel("Filename", { exact: true }).fill("renamed.tinta");
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
  });
  let download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("renamed.tinta");
  await expect(page.locator("header")).not.toContainText("Changed");
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("# Another change");
  await studioAction(page, "New");
  download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("renamed.tinta");
  await expect(page.locator("header")).toContainText("untitled.tinta");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("# Discarded");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("header")).not.toContainText("Changed");
});

test("recovery deletion and disabling are explicit and preserve the active buffer", async ({
  page,
}) => {
  await example(page);
  await studioAction(page, "Recovery");
  await page.getByLabel("Keep local recovery copies on this device").check();
  await page
    .getByRole("button", { name: "Show recovery copies", exact: true })
    .click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        if (
          !(await indexedDB.databases()).some(
            (item) => item.name === "tinta-recovery",
          )
        )
          return 0;
        return new Promise((resolve) => {
          const request = indexedDB.open("tinta-recovery", 1);
          request.onsuccess = () => {
            const db = request.result;
            const count = db
              .transaction("copies")
              .objectStore("copies")
              .count();
            count.onsuccess = () => {
              resolve(count.result);
              db.close();
            };
          };
        });
      }),
    )
    .toBe(1);
  await studioAction(page, "Recovery");
  await page.getByLabel("Keep local recovery copies on this device").uncheck();
  await page
    .getByRole("button", { name: "Show recovery copies", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete this recovery", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Recover guide.tinta", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Delete all local recovery copies",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Delete all", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Delete all", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Local recovery copies deleted.",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.frameLocator("iframe").getByLabel("Your platform"),
  ).toHaveValue("macOS");
});

test("JSON mappings, invalid imports and diagnostics preserve existing source", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill("{{ 1 / 0 }}");
  await page.locator(".diagnostics button").first().click();
  await expect(editor).toBeFocused();
  await editor.fill("# Data");
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Data" }),
  ).toBeVisible();
  await studioAction(page, "Import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "JSON data", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "values.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      '[{"Label":"00123","Value":2},{"Value":3,"Label":"00456"}]',
    ),
  });
  await page.getByLabel("Label → name", { exact: true }).fill("label");
  await page.getByLabel("Value type", { exact: true }).selectOption("text");
  await expect(page.getByRole("dialog").locator("pre")).toContainText("00123");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor).toHaveText("# Data");
  await studioAction(page, "Snippets");
  await page.getByRole("button", { name: "@toggle", exact: true }).click();
  await expect(editor).toContainText("@toggle visible");
});

async function previewBridge(page) {
  const { previewHtml } =
    await import("../../apps/studio/dist/studio-runtime.js");
  await page.goto("about:blank");
  await page.evaluate((html) => {
    const frame = document.createElement("iframe");
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    const channel = new MessageChannel();
    const header = {
      protocol: "tinta-host-1",
      documentId: "a".repeat(32),
      capability: "b".repeat(32),
      requestId: 0,
      sourceRevision: 1,
    };
    window.previewReplies = [];
    channel.port1.onmessage = (event) => window.previewReplies.push(event.data);
    window.previewSend = (kind, fields = {}) => {
      channel.port1.postMessage({
        ...header,
        requestId: ++header.requestId,
        kind,
        ...fields,
      });
    };
    window.addEventListener(
      "message",
      (event) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.kind === "hello"
        )
          frame.contentWindow.postMessage({ ...header, kind: "connect" }, "*", [
            channel.port2,
          ]);
      },
      { once: true },
    );
    frame.srcdoc = html;
    document.body.append(frame);
  }, previewHtml);
  await expect
    .poll(() => page.evaluate(() => window.previewReplies[0]?.kind))
    .toBe("ready");
}

test("preview capability handles only valid monotonic commands and closes on excess fields", async ({
  page,
}) => {
  const { compile } = await import("../../packages/engine/dist/index.js");
  const compiled = compile({
    text: '@slider value = 1 (min: 0, max: 3, label: "Value")',
    profile: "tinta",
    uri: "tinta:/document.tinta",
  });
  expect(compiled.ok).toBe(true);
  await previewBridge(page);
  await page.evaluate(
    (program) =>
      window.previewSend("load", {
        program,
        assets: [],
        baseline: { value: 2 },
      }),
    compiled.value,
  );
  await expect(
    page.frameLocator("iframe").getByLabel("Value", { exact: true }),
  ).toHaveValue("2");
  await page.evaluate(() =>
    window.previewSend("set-controls", { controls: { value: 3 } }),
  );
  await expect
    .poll(() => page.evaluate(() => window.previewReplies.at(-1)?.kind))
    .toBe("action-result");
  await page.evaluate(() => window.previewSend("get-state"));
  await expect
    .poll(() =>
      page.evaluate(() => window.previewReplies.at(-1)?.controls?.value),
    )
    .toBe(3);
  await page.evaluate(() => window.previewSend("reset"));
  await expect(
    page.frameLocator("iframe").getByLabel("Value", { exact: true }),
  ).toHaveValue("1");
  await page.evaluate(() =>
    window.previewSend("get-state", { fetch: "https://example.com" }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.previewReplies.at(-1)?.diagnostics?.[0]?.code),
    )
    .toBe("E_PROTOCOL");
  await expect(page.frameLocator("iframe").getByRole("article")).toHaveCount(0);
});

test("preview rejects untrusted IR and explicit destroy tears down the reader", async ({
  page,
}) => {
  await previewBridge(page);
  await page.evaluate(() =>
    window.previewSend("load", { program: { abi: "unknown" }, assets: [] }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.previewReplies.at(-1)?.diagnostics?.[0]?.code),
    )
    .toBe("E_PROTOCOL");
  await previewBridge(page);
  await page.evaluate(() => window.previewSend("destroy"));
  await expect
    .poll(() => page.evaluate(() => window.previewReplies.at(-1)?.kind))
    .toBe("destroyed");
});

test("a source revision change cancels an export before download handoff", async ({
  page,
}) => {
  await example(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.evaluate(() => {
    const stringify = JSON.stringify;
    JSON.stringify = function (value, ...options) {
      const serialized = stringify.call(JSON, value, ...options);
      if (value?.kind === "tinta-interactive") {
        JSON.stringify = stringify;
        // Mutate the real editor during artifact serialization, before the
        // completed bytes cross the host's revision guard.
        const view = document.querySelector(".cm-content").cmTile.root.view;
        view.dispatch({
          changes: { from: 0, insert: "# Changed during export\n\n" },
        });
      }
      return serialized;
    };
  });
  await page.getByRole("button", { name: "Export file", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Source changed during export. Export cancelled.",
  );
  expect(downloads).toEqual([]);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.locator("header")).toContainText("Changed");
});

test("editor surfaces expose labelled controls and accessible dialogs", async ({
  page,
}) => {
  await page.goto(url);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await example(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  expect(
    (await new AxeBuilder({ page }).exclude("iframe").analyze()).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect(
    (await new AxeBuilder({ page }).exclude("iframe").analyze()).violations,
  ).toEqual([]);
});

test("missing image resolution preserves distinct source paths with shared basenames", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const source = "![First](./pictures/photo.png)\n\n![Second](other/photo.png)";
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill(source);
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  const preview = page.frameLocator("iframe");
  await expect(preview.getByRole("article")).toContainText(
    "Image unavailable: First",
  );
  for (const [path, name, count] of [
    ["pictures/photo.png", "First", 1],
    ["other/photo.png", "Second", 2],
  ]) {
    await studioAction(page, "Import");
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Add missing image files", exact: true })
      .click();
    await (
      await chooser
    ).setFiles(
      resolve(
        "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
      ),
    );
    await page
      .getByLabel("Exact source image path", { exact: true })
      .fill(path);
    await page
      .getByRole("button", { name: "Resolve image", exact: true })
      .click();
    await expect(preview.getByRole("img", { name, exact: true })).toBeVisible();
    await expect(preview.getByRole("img")).toHaveCount(count);
    await expect(editor.locator(".cm-line")).toHaveText(source.split("\n"));
  }
  await editor.press("ControlOrMeta+z");
  await expect(
    preview.getByRole("img", { name: "First", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole("img", { name: "Second", exact: true }),
  ).toHaveCount(0);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect(preview.getByRole("img")).toHaveCount(2);
  const download = page.waitForEvent("download");
  await studioAction(page, "Save bundle");
  const bundle = await download;
  const chooser = page.waitForEvent("filechooser");
  await studioAction(page, "Open");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "images.tinta.zip",
    mimeType: "application/zip",
    buffer: await readFile(await bundle.path()),
  });
  await expect(preview.getByRole("img")).toHaveCount(2);
});

test("preview rejects unsafe, missing and indirect asset alias targets", async ({
  page,
}) => {
  const { compile } = await import("../../packages/engine/dist/index.js");
  const { createAsset } =
    await import("../../packages/artifacts/dist/index.js");
  const compiled = compile({
    text: "![First](pictures/photo.png)",
    profile: "tinta",
    uri: "tinta:/document.tinta",
  });
  const created = createAsset(
    new Uint8Array(
      await readFile(
        "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
      ),
    ),
  );
  expect(compiled.ok).toBe(true);
  expect(created.ok).toBe(true);
  const asset = created.value;
  for (const assetPaths of [
    [],
    { "../photo.png": asset.path },
    { "https://example.com/photo.png": asset.path },
    { "pictures/photo.png": "assets/missing.png" },
    { "pictures/photo.png": 42 },
    { "alias.png": asset.path, "pictures/photo.png": "alias.png" },
  ]) {
    await previewBridge(page);
    await page.evaluate(
      ({ program, asset, assetPaths }) => {
        window.previewSend("load", {
          program,
          assets: [{ ...asset, bytes: new Uint8Array(asset.bytes) }],
          assetPaths,
        });
      },
      {
        program: compiled.value,
        asset: { ...asset, bytes: [...asset.bytes] },
        assetPaths,
      },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => window.previewReplies.at(-1)?.diagnostics?.[0]?.code,
        ),
      )
      .toBe("E_PROTOCOL");
    await expect(page.frameLocator("iframe").getByRole("article")).toHaveCount(
      0,
    );
  }
});

test("document menus support keyboard dismissal, outside clicks and dialog focus return", async ({
  page,
}) => {
  await example(page, "article");
  const file = page
    .locator(".action-menu summary")
    .getByText("File", { exact: true });
  const tools = page
    .locator(".action-menu summary")
    .getByText("Tools", { exact: true });
  await file.press("Enter");
  await expect(
    page.getByRole("button", { name: "New", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).press("Escape");
  await expect(
    page.locator("summary").filter({ hasText: /^File$/ }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "New", exact: true }),
  ).not.toBeVisible();
  await file.click();
  await tools.click();
  await expect(
    page.getByRole("button", { name: "New", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).toBeVisible();
  await page.getByText("Source unchanged", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).not.toBeVisible();
  await studioAction(page, "Examples");
  await page.getByRole("dialog").press("Escape");
  await expect(
    page.locator("summary").filter({ hasText: /^Tools$/ }),
  ).toBeFocused();
  await page
    .locator("summary")
    .filter({ hasText: /^Tools$/ })
    .press("Escape");
  await expect(
    page.locator("summary").filter({ hasText: /^Tools$/ }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.locator("summary").filter({ hasText: /^Tools$/ }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Read", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("workspace reflows, retains the source cursor and exposes insertion from the narrow preview", async ({
  page,
}) => {
  await example(page, "article");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.press("ControlOrMeta+End");
  await expect
    .poll(() =>
      page.locator(".cm-scroller").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  const before = await page
    .locator(".cm-scroller")
    .evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".cm-scroller").evaluate((element) => element.scrollTop),
    )
    .toBe(before);
  await editor.press("Enter");
  await editor.pressSequentially("Cursor retained");
  await expect(editor).toContainText("Cursor retained");
  await expect
    .poll(() =>
      editor.evaluate((element) =>
        element.cmTile.root.view.state.doc.toString(),
      ),
    )
    .toBe(
      (await readFile("examples/article.tinta", "utf8")) + "\nCursor retained",
    );
  for (const width of [1440, 1100, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(editor).toBeVisible();
    if (width >= 1100) {
      const source = await page.locator(".source-pane").boundingBox();
      const preview = await page.locator(".preview-pane").boundingBox();
      expect(source.width).toBeGreaterThanOrEqual(400);
      expect(preview.width).toBeGreaterThanOrEqual(400);
      expect(source.width / (source.width + preview.width)).toBeCloseTo(
        0.48,
        2,
      );
    } else {
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(editor).not.toBeVisible();
      await expect(page.locator("iframe")).toBeVisible();
      await page.getByRole("button", { name: "Source", exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await studioAction(page, "Snippets");
  await page.getByRole("button", { name: "@toggle", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(
    page.locator("summary").filter({ hasText: /^Insert$/ }),
  ).toBeFocused();
  await expect(editor).toContainText("@toggle visible");
});

test("design review captures welcome, reading, editing, export and mobile surfaces", async ({
  page,
}, info) => {
  const capture = (name) =>
    page.screenshot({
      path: `reports/verification/studio-design-${info.project.name}-${name}.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await capture("welcome");
  await page
    .getByRole("button", { name: /02 An article you can explore/ })
    .click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "A hypothesis you can move", exact: true }),
  ).toBeVisible();
  await capture("reading");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await capture("editing");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture("export");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("@slider invalid = broken\n");
  await expect(page.getByRole("status")).toContainText("last valid source");
  await capture("diagnostics");
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeDisabled();
  await studioAction(page, "Examples");
  await page.getByRole("button", { name: "article", exact: true }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "A hypothesis you can move", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await capture("mobile");
  await page.setViewportSize({ width: 320, height: 800 });
  await studioAction(page, "Examples");
  expect(
    (await new AxeBuilder({ page }).exclude("iframe").analyze()).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await capture("forced-colors");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("new documents explain the empty state and clearing diagnostics does not leak across documents", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next idea starts here." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document source" })
    .fill("{{ 1 / 0 }}");
  await expect(page.locator(".diagnostics button")).not.toHaveCount(0);
  await studioAction(page, "New");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator(".diagnostics button")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your next idea starts here." }),
  ).toBeVisible();
});

test("catalogs describe their contents, filter without editing and close action menus", async ({
  page,
}, info) => {
  await example(page, "article");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await studioAction(page, "Examples");
  await expect(page.locator(".action-menu[open]")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/examples$/);
  await expect(
    page.getByRole("heading", { name: "Seven ways to see your data" }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: article"]')
      .getByRole("heading", { name: "A hypothesis you can move" }),
  ).toBeVisible();
  await page.screenshot({
    path: `reports/verification/studio-application-${info.project.name}-examples.png`,
    fullPage: true,
  });
  await page.getByRole("searchbox", { name: "Search examples" }).fill("seven");
  await expect(page.locator(".catalog-card")).toHaveCount(1);
  await page.getByRole("searchbox").fill("not-a-document");
  await expect(
    page.getByText("No matches. Try another word or category."),
  ).toBeVisible();
  await page.getByRole("dialog").press("Escape");
  await expect(page).toHaveURL(/#\/document\/.+\/read$/);
  await studioAction(page, "Snippets");
  await expect(page.locator(".action-menu[open]")).toHaveCount(0);
  await page.getByLabel("Category", { exact: true }).selectOption("Controls");
  await expect(page.locator(".catalog-card")).toHaveCount(3);
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @slider"]')
      .getByLabel("Amount"),
  ).toHaveValue("5");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @toggle"]')
      .getByLabel("Show more"),
  ).not.toBeChecked();
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @choice"]')
      .getByLabel("Option"),
  ).toHaveValue("First");
  await expect(page.locator(".catalog-sample pre")).toHaveCount(0);
  expect(
    (await page.getByRole("searchbox").boundingBox()).width,
  ).toBeGreaterThan(200);
  const cards = await page.locator(".catalog-card").all();
  expect((await cards[0].boundingBox()).y).toBe(
    (await cards[2].boundingBox()).y,
  );
  await page.screenshot({
    path: `reports/verification/studio-application-${info.project.name}-snippets.png`,
    fullPage: true,
  });
  expect(
    (await new AxeBuilder({ page }).exclude("iframe").analyze()).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "@toggle", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toContainText("@toggle visible");
  await expect(page).toHaveURL(/#\/document\/.+\/edit$/);
});

test("draft restoration resets answers and persistent opt-out prevents automatic reopening", async ({
  page,
}) => {
  await example(page);
  await page
    .frameLocator("iframe")
    .getByLabel("Your platform")
    .selectOption("Linux");
  await expect(page.locator(".local-note")).toContainText("up to date");
  await page.reload();
  await expect(
    page.frameLocator("iframe").getByLabel("Your platform"),
  ).not.toHaveValue("Linux");
  await studioAction(page, "Recovery");
  await page.getByLabel("Keep local recovery copies on this device").uncheck();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "New document", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Local recovery copies", exact: true })
    .click();
  await expect(
    page.getByLabel("Keep local recovery copies on this device"),
  ).not.toBeChecked();
});

test("direct section URLs and missing draft routes have usable recovery paths", async ({
  page,
}) => {
  await page.goto(url + "#/examples");
  await expect(
    page.getByRole("dialog", { name: "Explore examples" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await page.goto(url + "#/document/absent/read");
  await expect(page.getByRole("status")).toContainText("no longer available");
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await studioAction(page, "Home");
  await expect(
    page.getByRole("button", { name: "New document", exact: true }),
  ).toBeVisible();
});

test("declaration thumbnails demonstrate results without inserting their demonstration", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await studioAction(page, "Snippets");
  await page
    .getByLabel("Category", { exact: true })
    .selectOption("Calculations");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @let"]')
      .getByRole("article"),
  ).toContainText("A reusable value: 1");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @calc"]')
      .getByRole("article"),
  ).toContainText("The calculated total is 3");
  await page.getByLabel("Category", { exact: true }).selectOption("Data");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @data"]')
      .getByRole("table"),
  ).toContainText("2");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @view"]')
      .getByRole("table"),
  ).toContainText("1");
  await page.getByLabel("Category", { exact: true }).selectOption("Structure");
  await expect(
    page
      .frameLocator('iframe[title="Rendered thumbnail: @meta"]')
      .getByRole("heading", { name: "Your document" }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("named value");
  await expect(page.locator(".catalog-card")).toHaveCount(0);
  await page.getByLabel("Category", { exact: true }).selectOption("All");
  await page.getByRole("button", { name: "@let", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toContainText("@let value = 1");
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).not.toContainText("A reusable value");
});

test("new documents retain a clean checkpoint and home navigation respects the requested destination", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Document source" }),
  ).toBeVisible();
  await expect(page.locator(".preview-pane")).toBeVisible();
  await expect(page.locator(".document-checkpoint")).toHaveText(
    "Source unchanged",
  );
  await expect(page.locator(".local-note")).toContainText("up to date");
  await page.reload();
  await expect(page.locator(".document-checkpoint")).toHaveText(
    "Source unchanged",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill("# A draft to keep");
  await expect(page.locator(".document-checkpoint")).toHaveText("Changed");
  const documentUrl = page.url();
  await page.getByRole("link", { name: "tinta studio home" }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(
    page.getByRole("dialog", { name: "Unsaved source changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page).toHaveURL(documentUrl);
  await expect(editor).toHaveText("# A draft to keep");
  await page.evaluate(() => {
    location.hash = "#/home";
  });
  await expect(page).toHaveURL(/#\/home$/);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New document", exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await expect(page).toHaveURL(/#\/home$/);
  await expect(
    page.getByRole("button", { name: "New document", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await studioAction(page, "New");
  await expect(
    page.getByRole("button", { name: "Source", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
  await page.keyboard.type("# Ready to write");
  await expect(editor).toHaveText("# Ready to write");
});

test("dialog actions share one footer and reader actions remain outside the document", async ({
  page,
}) => {
  await example(page, "article");
  await expect(page.locator(".profile-badge")).toHaveText("1.0 draft");
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  await expect(page.locator(".studio-version")).toHaveText(
    /^v0\.0\.0 · [a-f0-9]{8}$/,
  );
  await expect(
    page.getByRole("button", { name: "Reset reading", exact: true }),
  ).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByRole("button", { name: "Reset reading" }),
  ).toHaveCount(0);
  await page
    .frameLocator("iframe")
    .getByLabel("Growth per period (%)")
    .fill("10");
  await page
    .getByRole("button", { name: "Reset reading", exact: true })
    .click();
  await expect(
    page.frameLocator("iframe").getByLabel("Growth per period (%)"),
  ).toHaveValue("5");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const footer = page.getByRole("dialog").locator(".dialog-actions");
  await expect(
    footer.getByRole("button", { name: "Export file", exact: true }),
  ).toBeVisible();
  await expect(
    footer.getByRole("button", { name: "Export file", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("dialog").locator(":scope > button:not(.dialog-close)"),
  ).toHaveCount(0);
});

test("parser decorations cover every directive and exclude literal fenced source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const source = [
    '@meta (version: "1.0", title: "Highlights")',
    "@let base = 1",
    "@slider amount = 2 (min: 0, max: 10)",
    "@calc total = base + amount",
    "@toggle visible = true",
    '@choice option = "A" (options: ["A", "B"])',
    "@data points",
    "x:number | y:number",
    "1 | 2",
    "@end",
    "@view filtered = points (where: row.x > 0)",
    '@table filtered (title: "Values")',
    '@chart line points (x: "x", y: "y")',
    "@when visible",
    "Total: {{ total }}.",
    "@end",
    '@details "More"',
    "An explanation.",
    "@end",
    "",
    "```text",
    "@meta literal",
    "{{ literal }}",
    "```",
  ].join("\n");
  await page.getByRole("textbox", { name: "Document source" }).fill(source);
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  const marks = page.locator(".tinta-token");
  for (const name of [
    "meta",
    "let",
    "slider",
    "calc",
    "toggle",
    "choice",
    "data",
    "view",
    "table",
    "chart",
    "when",
    "details",
    "end",
  ]) {
    await expect(
      marks.filter({ hasText: new RegExp(`^@${name}\\b`) }).first(),
    ).toBeVisible();
  }
  await expect(marks.filter({ hasText: "{{ total }}" })).toBeVisible();
  await expect(marks.filter({ hasText: "literal" })).toHaveCount(0);
  expect(
    await marks
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(238, 237, 245)");
  expect(
    await marks.first().evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(40, 43, 50)");
});

test("renaming preserves source and profile and persists the next save filename", async ({
  page,
  browserName,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.fill("# A local draft");
  const documentUrl = page.url();
  await page
    .getByRole("button", { name: "Rename untitled.tinta", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rename", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Document name", exact: true })
    .fill("");
  await expect(
    page.getByRole("button", { name: "Rename", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Document name", exact: true })
    .fill("My research");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator(".filename-stem")).toHaveText("My research");
  await expect(page.locator(".filename-extension")).toHaveText(".tinta");
  await expect(page.locator(".document-checkpoint")).toHaveText("Changed");
  await expect(editor).toHaveText("# A local draft");
  await expect(page).toHaveURL(documentUrl);
  await expect(page.locator(".local-note")).toContainText("up to date");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Rename My research.tinta", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.requestedDownloadFilename = this.download;
      return click.call(this);
    };
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  const file = await download;
  expect(await page.evaluate(() => window.requestedDownloadFilename)).toBe(
    "My research.tinta",
  );
  expect(file.suggestedFilename()).toBe(
    browserName === "webkit" && process.platform === "linux"
      ? "My_research.tinta"
      : "My research.tinta",
  );
  expect(await readFile(await file.path(), "utf8")).toBe("# A local draft");
  await expect(page.locator(".document-checkpoint")).toHaveText(
    "Source unchanged",
  );
  await page
    .getByRole("button", { name: "Rename My research.tinta", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Document name", exact: true })
    .fill("Cancelled name");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rename My research.tinta", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".document-checkpoint")).toHaveText(
    "Source unchanged",
  );
});
