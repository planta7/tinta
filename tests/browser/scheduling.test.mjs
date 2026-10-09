import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, studioAction } from "./fixtures.mjs";

test("editor and recovery debounce at their exact idle boundaries and cancel older work", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    globalThis.schedulingEvidence = { compiles: [], saves: [] };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message.kind === "compile") {
        globalThis.schedulingEvidence.compiles.push(message.source);
      }
      return post.call(this, message, ...rest);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === "copies") {
        globalThis.schedulingEvidence.saves.push(value.source);
      }
      return put.call(this, value, ...rest);
    };
  });
  await page.goto(pathToFileURL(resolve("build/tinta-studio.html")).href);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
  await studioAction(page, "Recovery", { force: true });
  await page
    .getByLabel("Keep local recovery copies on this device")
    .check({ force: true });
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .click({ force: true });
  const editor = page.getByRole("textbox", { name: "Document source" });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nFirst boundary");
  await page.evaluate(() => {
    globalThis.schedulingEvidence.compiles = [];
    globalThis.schedulingEvidence.saves = [];
  });
  await page.clock.runFor(199);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.compiles),
  ).toEqual([]);
  await page.clock.runFor(1);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.compiles),
  ).toEqual([expect.stringContaining("First boundary")]);
  await page.clock.runFor(799);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.saves),
  ).toEqual([]);
  await page.clock.runFor(1);
  await expect
    .poll(() => page.evaluate(() => globalThis.schedulingEvidence.saves))
    .toEqual([expect.stringContaining("First boundary")]);

  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" old");
  await page.clock.runFor(199);
  await page.keyboard.insertText(" newest");
  const previous = await page.evaluate(
    () => globalThis.schedulingEvidence.compiles.length,
  );
  await page.clock.runFor(1);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.compiles.length),
  ).toBe(previous);
  await page.clock.runFor(199);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.compiles.at(-1)),
  ).toContain("old newest");
  await page.clock.runFor(799);
  expect(
    await page.evaluate(() => globalThis.schedulingEvidence.saves),
  ).toHaveLength(1);
  await page.clock.runFor(1);
  await expect
    .poll(() => page.evaluate(() => globalThis.schedulingEvidence.saves.at(-1)))
    .toContain("old newest");
});
