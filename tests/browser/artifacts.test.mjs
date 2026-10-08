import { test, expect } from "./fixtures.mjs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  createAsset,
  exportHtml,
  unwrap,
} from "../../packages/artifacts/dist/index.js";

import { build } from "esbuild";
import { classicBundle } from "../../scripts/packaging.mjs";
import { createHash } from "node:crypto";
import { readerCoverage } from "../../scripts/reader-coverage.mjs";

const coverage = [];
let coverageRuntime;
let runtimeCode;
test.beforeAll(async ({ browserName }) => {
  if (browserName !== "chromium") return;
  const directory = resolve("build/export-coverage");
  await mkdir(directory, { recursive: true });
  coverageRuntime = join(directory, "runtime.js");
  await build({
    entryPoints: ["packages/reader/src/export-runtime.ts"],
    outfile: coverageRuntime,
    bundle: true,
    format: "iife",
    globalName: "TintaExportRuntime",
    platform: "browser",
    target: "es2022",
    sourcemap: "external",
  });
  runtimeCode = await readFile(coverageRuntime, "utf8");
  const built = JSON.parse(await readFile("build/export-runtime.json", "utf8"));
  expect(built.code.startsWith(runtimeCode)).toBe(true);
});
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
});
test.afterEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    coverage.push(
      ...(await page.coverage.stopJSCoverage()).filter((entry) =>
        entry.source?.startsWith(runtimeCode),
      ),
    );
});
test.afterAll(async ({ browserName }) => {
  if (browserName === "chromium")
    await readerCoverage(coverage, coverageRuntime + ".map", {
      sources: ["export-runtime.ts"],
      report: "reports/verification/export-coverage.json",
    });
});

async function exported(
  text,
  format = "interactive",
  current,
  assets = new Map(),
) {
  const program = unwrap(
    compile({
      text,
      profile: "tinta",
      uri: "file:///private/owner/document.tinta",
    }),
  );
  const session = unwrap(createSession(program));
  if (current) unwrap(session.setControls(current));
  try {
    return unwrap(
      await exportHtml(session, assets, {
        format,
        answers: current ? "current" : "initial",
      }),
    ).bytes;
  } finally {
    session.destroy();
  }
}

async function visit(page, bytes, operation) {
  const folder = await mkdtemp(join(tmpdir(), "tinta-export-"));
  try {
    const path = join(folder, "document.html");
    await writeFile(path, bytes);
    const requests = [];
    page.on("websocket", (socket) => requests.push(socket.url()));
    await page.route(/https?:\/\//, (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.goto(pathToFileURL(path).href);
    await operation(requests);
    expect(requests).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

for (const name of ["article", "report", "guide", "chart-atlas"]) {
  test(`offline standalone ${name} initializes complete document`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await visit(
      page,
      await exported(await readFile(`examples/${name}.tinta`, "utf8")),
      async () => {
        await expect(
          page.getByRole("button", { name: "Reset reading", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            "Interactivity requires JavaScript; the values below are the exported answers.",
          ),
        ).toHaveCount(0);
        expect(errors).toEqual([]);
        expect(await page.locator(".tinta-reader").count()).toBe(1);
        await page
          .getByRole("button", { name: "Reset reading", exact: true })
          .click();
        if (name === "report") {
          await page.getByLabel("Include weekends").check();
          await page.getByLabel("Minimum readings").fill("100");
          await page.getByLabel("Day to inspect").selectOption("Tue");
          const figure = page.locator("figure").first();
          await figure
            .getByRole("button", { name: "audio", exact: true })
            .click();
          await figure.getByLabel("Inspect data point").focus();
          await figure.getByLabel("Inspect data point").press("End");
          await figure
            .getByRole("button", { name: "Use inspected value", exact: true })
            .click();
        }
      },
    );
  });
}
test("current answers become reset baseline, hidden content is safe, payload terminators inert", async ({
  page,
}) => {
  const source =
    '@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")\n' +
    '@toggle show = false (label: "Show hidden")\n' +
    "\nTotal: {{ amount }}\n\n@when show\n\nHIDDEN CONTENT\n\n@end\n\n```\n</scr" +
    "ipt><script>globalThis.compromised=true</script>\n" +
    '& "quoted" \u2028\u2029\n```\n';
  await visit(
    page,
    await exported(source, "interactive", { amount: 7, show: false }),
    async () => {
      const slider = page.getByRole("slider", { name: "Amount" });
      await expect(slider).toHaveValue("7");
      await slider.focus();
      await slider.press("ArrowRight");
      await expect(slider).toHaveValue("8");
      await page.getByRole("checkbox", { name: "Show hidden" }).check();
      await expect(
        page.getByText("HIDDEN CONTENT", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Reset reading", exact: true })
        .click();
      await expect(slider).toHaveValue("7");
      await expect(
        page.getByText("HIDDEN CONTENT", { exact: true }),
      ).toHaveCount(0);
      expect(await page.evaluate(() => globalThis.compromised)).toBeUndefined();
    },
  );
});
test("JavaScript disabled retains selected-answer fallback", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await visit(
      page,
      await exported(
        "@slider amount = 1 (min: 0, max: 10)\n\nAnswer: {{ amount }}\n",
        "interactive",
        { amount: 9 },
      ),
      async () => {
        await expect(
          page.getByText(
            "Interactivity requires JavaScript; the values below are the exported answers.",
          ),
        ).toBeVisible();
        await expect(
          page.getByText("Answer: 9", { exact: true }),
        ).toBeVisible();
        await expect(page.locator("input[type=range]")).toHaveCount(0);
      },
    );
  } finally {
    await context.close();
  }
});
test("static output omits hidden material and expands visible details", async ({
  page,
}) => {
  const source =
    "@toggle show = false\n" +
    '\n@when show\n\nSECRET\n\n![missing](missing.png)\n\n@end\n\n@details "Mor' +
    'e"\n\nVISIBLE DETAIL\n\n@end\n';
  await visit(page, await exported(source, "static"), async () => {
    await expect(
      page.getByText("VISIBLE DETAIL", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("script")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("missing.png");
  });
});
test("local PNG, JPEG and WebP bytes decode with no network requests", async ({
  page,
}) => {
  const images = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    return ["image/png", "image/jpeg", "image/webp"].map((mime) => ({
      mime,
      url: canvas.toDataURL(mime),
    }));
  });
  const assets = new Map();
  let source = "";
  for (const [index, item] of images.entries()) {
    // A browser without a WebP encoder reports PNG; the decode fixture below still covers WebP.
    const bytes = Buffer.from(item.url.split(",")[1], "base64");
    assets.set(`picture${index}.bin`, unwrap(createAsset(bytes)));
    source += `![Picture ${index}](picture${index}.bin)\n\n`;
  }
  const webp = Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    "base64",
  );
  assets.set("explicit.webp", unwrap(createAsset(webp)));
  source += "![Explicit WebP](explicit.webp)\n";
  await visit(
    page,
    await exported(source, "interactive", undefined, assets),
    async () => {
      await expect(
        page.getByRole("button", { name: "Reset reading", exact: true }),
      ).toBeVisible();
      await expect(page.locator("img")).toHaveCount(4);
      await expect
        .poll(() =>
          page
            .locator("img")
            .evaluateAll((images) =>
              images.every((image) => image.complete && image.naturalWidth > 0),
            ),
        )
        .toBe(true);
    },
  );
});
test("tampered envelope fails closed and leaves fallback", async ({ page }) => {
  const bytes = await exported("# Original\n");
  const altered = Buffer.from(
    Buffer.from(bytes)
      .toString("utf8")
      .replace('"engineVersion":"0.0.0"', '"engineVersion":"9.9.9"'),
  );
  await visit(page, altered, async () => {
    await expect(page.getByRole("alert")).toContainText("could not initialize");
    await expect(
      page.getByText(
        "Interactivity requires JavaScript; the values below are the exported answers.",
      ),
    ).toBeVisible();
  });
});

for (const answers of [undefined, { growth: 10, period: 2 }]) {
  test(`article export baseline ${answers ? "current" : "initial"}`, async ({
    page,
  }) => {
    const source = await readFile("examples/article.tinta", "utf8");
    await visit(
      page,
      await exported(source, "interactive", answers),
      async () => {
        const expected = answers ? "121" : "110";
        await expect(page.locator(".tinta-reader")).toContainText(expected);
        const growth = page.getByRole("slider", {
          name: "Growth per period (%)",
        });
        await growth.focus();
        await growth.press("ArrowRight");
        await page
          .getByRole("button", { name: "Reset reading", exact: true })
          .click();
        await expect(growth).toHaveValue(answers ? "10" : "5");
        await expect(page.locator(".tinta-reader")).toContainText(expected);
      },
    );
    expect(source).toContain("@slider growth = 5");
  });
}

test("static guide discloses only the selected platform", async ({ page }) => {
  const source = await readFile("examples/guide.tinta", "utf8");
  const bytes = await exported(source, "static", {
    platform: "macOS",
    more_detail: false,
  });
  const html = Buffer.from(bytes).toString("utf8");
  expect(html).not.toContain("Windows");
  expect(html).not.toContain("Linux");
  expect(html).not.toContain("tinta-interactive");
  await visit(page, bytes, async () => {
    await expect(page.locator("article")).toContainText("Finder");
    await expect(page.locator("select")).toHaveCount(0);
  });
});

test("external links navigate only after explicit activation", async ({
  page,
  context,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "tinta-link-"));
  const requests = [];
  await context.route("https://example.invalid/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      contentType: "text/html",
      body: "<p>Destination</p>",
    });
  });
  try {
    const path = join(folder, "document.html");
    await writeFile(
      path,
      await exported("[External](https://example.invalid/visit)\n"),
    );
    await page.goto(pathToFileURL(path).href);
    const link = page.getByRole("link", { name: "External" });
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(requests).toEqual([]);
    const opened = page.waitForEvent("popup");
    await link.click();
    const popup = await opened;
    await expect(popup.getByText("Destination")).toBeVisible();
    expect(requests).toEqual(["https://example.invalid/visit"]);
    await popup.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("runtime rejects malformed authenticated envelopes without discarding fallback", async ({
  page,
}) => {
  const asset = unwrap(
    createAsset(
      Buffer.from(
        "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        "base64",
      ),
    ),
  );
  const bytes = await exported(
    "![Picture](picture.webp)\n",
    "interactive",
    undefined,
    new Map([["picture.webp", asset]]),
  );
  await visit(page, bytes, async () => {
    const original = await page.locator("#tinta-payload").textContent();
    const mutations = [
      (value) => {
        value.kind = "unknown";
      },
      (value) => {
        value.baseline.sourceSha256 = "0".repeat(64);
      },
      (value) => {
        value.assets[0].base64 = "%";
      },
      (value) => {
        value.assets[0].base64 = "AB==";
      },
      (value) => {
        value.assets[0].mime = "image/png";
      },
      (value) => {
        value.assets.push(value.assets[0]);
      },
      (value) => {
        value.assets = [];
      },
      (value) => {
        value.baseline.controls = { unknown: true };
      },
    ];
    for (const mutate of mutations) {
      const value = JSON.parse(original);
      mutate(value);
      const text = JSON.stringify(value);
      const digest = createHash("sha256").update(text).digest("hex");
      await page.evaluate(
        ({ text, digest }) => {
          document.getElementById("tinta-content").textContent =
            "Preserved fallback";
          document.getElementById("tinta-payload").textContent = text;
          globalThis.TintaExportRuntime.start(digest);
        },
        { text, digest },
      );
      await expect(page.getByRole("alert")).toContainText(
        "could not initialize",
      );
      await expect(page.locator("#tinta-content")).toContainText(
        "Preserved fallback",
      );
    }
    await page.evaluate(() => {
      document.getElementById("tinta-payload").remove();
      globalThis.TintaExportRuntime.start("invalid");
      document.getElementById("tinta-content").remove();
      globalThis.TintaExportRuntime.start("invalid");
      dispatchEvent(new Event("pagehide"));
    });
  });
});

test("exports retain answers but reset legend, pin and details presentation", async ({
  page,
}) => {
  const bundle = await classicBundle("tests/browser/artifact-harness.mjs");
  await page.addScriptTag({ content: bundle.code });
  await page.evaluate(
    (source) => globalThis.exportTest.mount(source),
    await readFile("examples/report.tinta", "utf8"),
  );
  await page.getByLabel("Include weekends").check();
  const figure = page.locator("figure").first();
  await figure.getByRole("button", { name: "audio", exact: true }).click();
  await figure
    .getByRole("button", { name: "Use inspected value", exact: true })
    .click();
  await expect(figure.locator("p").last()).toContainText("Pinned");
  await page.getByText("Read the selected rows", { exact: true }).click();
  await expect(
    figure.getByRole("button", { name: "audio", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  const outputs = await page.evaluate(async () => ({
    interactive: await globalThis.exportTest.export("interactive"),
    static: await globalThis.exportTest.export("static"),
  }));
  await visit(page, Buffer.from(outputs.interactive), async () => {
    await expect(page.getByLabel("Include weekends")).toBeChecked();
    await expect(
      page.locator("figure").first().getByRole("button", {
        name: "audio",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".tinta-reader details[open]")).toHaveCount(0);
    await expect(
      page.locator("figure").first().locator("p").last(),
    ).not.toContainText("Pinned");
  });
  await visit(page, Buffer.from(outputs.static), async () => {
    await expect(page.locator("figure").first().locator("table")).toContainText(
      "audio",
    );
    await expect(
      page.getByText("The same rows used by the report — 4 rows", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("article")).toContainText(
      "Include weekends: true",
    );
  });
});
