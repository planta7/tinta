import { installProbe } from "../../scripts/performance-browser.mjs";
import { test, expect } from "./fixtures.mjs";

test("preview measurement observes document content after toolbar removal", async ({
  page,
}) => {
  await page.setContent(
    "<main><article><div><p>Before</p></div>" +
      '<div class="tinta-reader-status"><span>Before</span></div>' +
      "</article></main>",
  );
  await page.evaluate(() => {
    // This regression measures DOM completion, not long-task collection.
    // Firefox and WebKit do not expose Chromium's long-task entry type.
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      globalThis.PerformanceObserver = class {
        static supportedEntryTypes = ["longtask"];
        observe() {}
        takeRecords() {
          return [];
        }
      };
    }
  });
  await page.evaluate(installProbe);
  await page.evaluate(() => {
    globalThis.previewCompleted = false;
    globalThis.interactionProbe.armPreview("After");
    globalThis.interactionProbe.preview.then(() => {
      globalThis.previewCompleted = true;
    });
    document.querySelector(".tinta-reader-status span").textContent = "After";
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  expect(await page.evaluate(() => globalThis.previewCompleted)).toBe(false);
  await page.evaluate(() => {
    document.querySelector("article > div > p").textContent = "After";
    return globalThis.interactionProbe.preview;
  });
  expect(await page.evaluate(() => globalThis.previewCompleted)).toBe(true);
});
