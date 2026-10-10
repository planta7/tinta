import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparePreview } from "../../packages/language-service/dist/index.js";
import { encodeUtf8, hash } from "../../packages/types/dist/common.js";
import { readerCoverage } from "../../scripts/reader-coverage.mjs";
import {
  previewHtml,
  previewScriptHash,
  previewStyleHash,
} from "../../apps/vscode/dist/preview-runtime.js";
const path = resolve("build/vscode-coverage/outer.js");
let code;
const coverage = [];
const digest = (text) => createHash("sha256").update(text).digest("base64");
const source = (text, version = 1) => ({
  uri: "untitled:preview",
  profile: "tinta",
  documentInstance: "a".repeat(32),
  editorVersion: version,
  sourceRevision: version - 1,
  sourceSha256: hash(encodeUtf8(text)),
});
const header = (text, version = 1) => ({
  protocol: "tinta-vscode-1",
  panelId: "b".repeat(32),
  capability: "c".repeat(32),
  requestId: 0,
  source: source(text, version),
});
const sample =
  '@slider amount = 5 (min: 0, max: 10, step: 1, label: "Amount")\n@calc ratio = 1 / amount\nRatio: {{ ratio }}\n@details "More"\nDetails text.\n@end\n';

test.beforeAll(async () => {
  await mkdir("build/vscode-coverage", { recursive: true });
  await build({
    entryPoints: ["apps/vscode/dist/webview/index.js"],
    outfile: path,
    bundle: true,
    platform: "browser",
    format: "iife",
    sourcemap: "external",
  });
  code = await readFile(path, "utf8");
  await writeFile(
    "build/vscode-coverage/host.html",
    "<!doctype html><html><body></body></html>",
  );
});
test.beforeEach(async ({ page }) =>
  page.coverage.startJSCoverage({
    resetOnNavigation: false,
    reportAnonymousScripts: true,
  }),
);
test.afterEach(async ({ page }) =>
  coverage.push(...(await page.coverage.stopJSCoverage())),
);
test.afterAll(async () => {
  const summary = await readerCoverage(
    coverage
      .filter((item) => item.source === code)
      .map((item) => ({ ...item, url: pathToFileURL(path).href })),
    path + ".map",
    {
      sourceRoot: "apps/vscode/dist/webview",
      sources: ["index.js"],
      report: "reports/verification/vscode-webview-coverage.json",
    },
  );
  for (const [kind, minimum] of Object.entries({
    statements: 85,
    branches: 80,
    functions: 85,
    lines: 85,
  }))
    expect(summary[kind].pct, `${kind} coverage`).toBeGreaterThanOrEqual(
      minimum,
    );
});

async function open(page, text = sample, html = previewHtml) {
  await page.goto(
    pathToFileURL(resolve("build/vscode-coverage/host.html")).href,
  );
  page.on("console", (event) => {
    if (event.type() === "error") console.log(event.text());
  });
  const identity = header(text);
  const bootstrap = `var tintaBootstrap = ${JSON.stringify({ identity, previewHtml: html }).replace(/</g, "\\u003c")}; window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.messages.push(message) });`;
  await page.setContent(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest(bootstrap)}' 'sha256-${digest(code)}' 'sha256-${previewScriptHash}'; style-src 'sha256-${previewStyleHash}'; img-src data: blob:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"></head><body><script>${bootstrap}</script><script>${code}</script></body></html>`,
  );
  await expect
    .poll(() => page.evaluate(() => window.messages[0]?.kind))
    .toBe("ready");
  return identity;
}
async function send(page, identity, kind, fields = {}) {
  identity.requestId++;
  await page.evaluate(
    (message) => window.postMessage(message, "*"),
    JSON.parse(JSON.stringify({ ...identity, kind, ...fields })),
  );
}
async function load(page, identity, text = sample, fields = {}) {
  const program = preparePreview(identity.source, text).result.value;
  await send(page, identity, "load", {
    program,
    assets: [],
    assetPaths: {},
    baseline: {},
    assetRevision: 0,
    ...fields,
  });
}
const reader = (page) => page.frameLocator("iframe");
async function failed(page) {
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.messages.at(-1)?.kind))
    .toBe("diagnostics");
}

test("reconciles, rolls back atomically, resets presentation and retains reader-only details", async ({
  page,
}) => {
  const identity = await open(page);
  await load(page, identity);
  const slider = reader(page).getByRole("slider", { name: "Amount" });
  await expect(slider).toHaveValue("5");
  await slider.fill("4");
  await slider.dispatchEvent("input");
  await expect(reader(page).locator("body")).toContainText("Ratio: 0.25");
  await reader(page).getByText("More", { exact: true }).click();
  await slider.fill("3");
  await slider.dispatchEvent("input");
  await expect(reader(page).locator("details")).toHaveAttribute("open", "");
  await slider.fill("0");
  await slider.dispatchEvent("input");
  await expect(slider).toHaveValue("3");
  await send(page, identity, "set-enabled", { enabled: false });
  await expect(slider).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("last valid source");
  const revised = sample + "\nProse changed.";
  identity.source = source(revised, 2);
  await load(page, identity, revised);
  await expect(slider).toHaveValue("3");
  await expect(reader(page).locator("details")).not.toHaveAttribute("open", "");
  // Retaining amount=3 would divide by zero; all authored defaults must win.
  const fallback = sample.replace("1 / amount", "1 / (amount - 3)");
  identity.source = source(fallback, 3);
  await load(page, identity, fallback);
  await expect(slider).toHaveValue("5");
  await expect(page.locator("body > details")).toContainText("1 answers reset");
  const changedInitial = sample.replace("amount = 5", "amount = 2");
  identity.source = source(changedInitial, 4);
  await load(page, identity, changedInitial);
  await expect(slider).toHaveValue("2");
  await slider.fill("4");
  await slider.dispatchEvent("input");
  await send(page, identity, "get-state");
  await expect
    .poll(() => page.evaluate(() => window.messages.at(-1)?.controls?.amount))
    .toBe(4);
  await send(page, identity, "reset");
  await expect(slider).toHaveValue("2");
  await send(page, identity, "destroy");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.messages.at(-1)?.kind))
    .toBe("destroyed");
});

for (const attack of [
  "capability",
  "document",
  "unknown",
  "program",
  "hash",
  "asset",
  "alias",
  "revision",
  "source-change",
  "initial",
  "base64",
  "duplicate-asset",
]) {
  test(`rejects ${attack} at the outer boundary`, async ({ page }) => {
    const identity = await open(page);
    if (attack === "capability") identity.capability = "d".repeat(32);
    if (attack === "document")
      identity.source.documentInstance = "d".repeat(32);
    if (attack === "unknown") {
      await send(page, identity, "read-file", { path: "/etc/passwd" });
    } else if (attack === "program")
      await load(page, identity, sample, { program: {} });
    else if (attack === "hash") {
      const program = preparePreview(identity.source, sample).result.value;
      identity.source.sourceSha256 = "d".repeat(64);
      await send(page, identity, "load", {
        program,
        assets: [],
        assetPaths: {},
        baseline: {},
        assetRevision: 0,
      });
    } else if (["asset", "base64", "duplicate-asset"].includes(attack)) {
      const asset = {
        path: `assets/${"a".repeat(64)}.png`,
        sha256: "a".repeat(64),
        mime: "image/png",
        bytesBase64: attack === "base64" ? "AB==" : "AA==",
      };
      await load(page, identity, sample, {
        assets: attack === "duplicate-asset" ? [asset, { ...asset }] : [asset],
      });
    } else if (attack === "alias")
      await load(page, identity, sample, { assetPaths: { image: "missing" } });
    else if (attack === "initial") {
      const invalid = sample.replace("amount = 5", "amount = 0");
      // Compilation can produce IR even when initial evaluation fails.
      const { compile, encodeProgram } =
        await import("../../packages/engine/dist/index.js");
      identity.source = source(invalid, 2);
      await send(page, identity, "load", {
        program: encodeProgram(
          compile({ uri: identity.source.uri, profile: "tinta", text: invalid })
            .value,
        ),
        assets: [],
        assetPaths: {},
        baseline: {},
        assetRevision: 0,
      });
    } else if (attack === "revision") {
      await load(page, identity);
      await expect(reader(page).getByRole("slider")).toBeVisible();
      identity.source = source(sample, 0);
      await send(page, identity, "reset");
    } else if (attack === "source-change") {
      identity.source = source("Other", 2);
      await send(page, identity, "set-enabled", { enabled: true });
    } else await load(page, identity);
    await failed(page);
  });
}

test("rejects an unauthenticated hello from outside the preview frame", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.postMessage({ protocol: "tinta-host-1", kind: "hello" }, "*"),
  );
  await failed(page);
});

test("ignores a well-formed superseded request without replaying it", async ({
  page,
}) => {
  const identity = await open(page);
  await load(page, identity);
  const slider = reader(page).getByRole("slider");
  await expect(slider).toHaveValue("5");
  await send(page, identity, "set-enabled", { enabled: false });
  await page.evaluate((message) => window.postMessage(message, "*"), {
    ...identity,
    kind: "set-enabled",
    enabled: true,
  });
  await expect(slider).toBeDisabled();
});
