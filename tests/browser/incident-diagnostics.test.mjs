import { test, expect } from "./fixtures.mjs";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let html;
test.beforeAll(async ({ browserName }) => {
  const directory = resolve("build/incident-tests", browserName);
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: ["tests/browser/incident-harness.mjs"],
    outfile: resolve(directory, "reader.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
  });
  html = resolve(directory, "index.html");
  await writeFile(
    html,
    '<!doctype html><html lang="en"><title>Incident diagnostics</title><main></main><script src="reader.js"></script></html>',
  );
});
test.beforeEach(async ({ page }) => {
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(html).href);
});

test("reader host faults display incidents and retain source, answers and focus", async ({
  page,
}) => {
  await page.getByRole("slider").focus();
  await page.getByRole("slider").fill("5");
  await expect(page.getByRole("slider")).toHaveValue("2");
  await expect(page.getByRole("slider")).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    /E_INTERNAL: .*Incident: [a-f0-9]{32}\./,
  );
  await page.getByRole("button", { name: "Reset reading" }).click();
  await expect(page.getByRole("status")).toContainText(
    /Reader reset failed\. Incident: [a-f0-9]{32}\./,
  );
  const result = await page.evaluate(() => {
    const test = globalThis.incidentTest;
    test.result.value.destroy();
    return {
      diagnostics: test.diagnostics,
      source: test.session.program.source,
      state: test.session.getRevision().state,
    };
  });
  expect(result.state.amount).toBe(2);
  expect(result.source).toContain("# Preserved");
  expect(result.diagnostics).toHaveLength(3);
  const ids = result.diagnostics.map((item) => {
    expect(item.details.incidentId).toMatch(/^[a-f0-9]{32}$/);
    expect(item.message).toContain(item.details.incidentId);
    return item.details.incidentId;
  });
  expect(new Set(ids).size).toBe(3);
  expect(JSON.stringify(result.diagnostics)).not.toContain("private");
});

test("engine subscriber faults gain host incidents without losing the committed answer", async ({
  page,
}) => {
  await page.evaluate(() => {
    globalThis.incidentTest.setOperation("normal");
    globalThis.incidentTest.failSubscriber();
  });
  await page.getByRole("slider").fill("5");
  await expect(page.getByRole("slider")).toHaveValue("5");
  await expect(page.getByRole("status")).toContainText(
    /Incident: [a-f0-9]{32}\./,
  );
  const item = await page.evaluate(() =>
    globalThis.incidentTest.diagnostics.at(-1),
  );
  expect(item.code).toBe("E_INTERNAL");
  expect(item.message).toContain(item.details.incidentId);
  expect(JSON.stringify(item)).not.toContain("private");
});

test("diagnostic callback faults display a local incident without recursive reporting", async ({
  page,
}) => {
  await page.evaluate(() => globalThis.incidentTest.setOperation("diagnostic"));
  await page.getByRole("button", { name: "Reset reading" }).click();
  await expect(page.getByRole("status")).toContainText(
    /A diagnostic subscriber failed\. Incident: [a-f0-9]{32}\./,
  );
  expect(
    await page.evaluate(() => globalThis.incidentTest.diagnostics.length),
  ).toBe(1);
  await expect(page.locator("body")).not.toContainText("private");
});

test("Studio artifact faults expose an incident while ordinary errors retain their explanation", async ({
  page,
  browserName,
}) => {
  const directory = resolve("build/incident-tests", browserName);
  await build({
    entryPoints: ["tests/browser/incident-studio-harness.mjs"],
    outfile: resolve(directory, "studio.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ path: resolve(directory, "studio.js") });
  const messages = await page.evaluate(() =>
    globalThis.describeInternalArtifactFault(),
  );
  expect(messages[0]).toMatch(
    /^E_INTERNAL: Unexpected internal failure\. Incident: [a-f0-9]{32}\.$/,
  );
  expect(messages[0]).not.toContain("private");
  expect(messages[1]).toBe("Source byte limit exceeded.");
});

test("rebuilt portable Studio opens offline and starts its compiler and reader", async ({
  page,
}) => {
  const external = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) external.push(request.url());
  });
  await page.goto(pathToFileURL(resolve("build/tinta-studio.html")).href);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await page
    .locator(".cm-content")
    .fill(
      "# Incident update\n\n@slider amount = 2 (min: 0, max: 10)\n\nAmount: {{ amount }}",
    );
  const preview = page.frameLocator('iframe[title="Document preview"]');
  await expect(preview.getByRole("slider")).toHaveValue("2");
  await preview.getByRole("slider").fill("5");
  await expect(preview.getByText("Amount: 5", { exact: true })).toBeVisible();
  expect(external).toEqual([]);
});
