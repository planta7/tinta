import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assessStudioRuns } from "./performance-policy.mjs";

export async function measureWorker(page, source) {
  const code = await readFile("build/worker.js", "utf8");
  return page.evaluate(
    ({ code, source }) =>
      new Promise((resolve) => {
        const started = performance.now();
        const url = URL.createObjectURL(
          new Blob([code], { type: "text/javascript" }),
        );
        const worker = new Worker(url);
        const finish = (result) => {
          clearTimeout(watchdog);
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve({
            ...result,
            elapsed: performance.now() - started,
            sourceUnits: source.length,
          });
        };
        const watchdog = setTimeout(() => finish({ status: "TIMEOUT" }), 3000);
        worker.onmessage = ({ data }) =>
          finish({ status: "RESPONSE", response: data });
        worker.onerror = (event) =>
          finish({ status: "ERROR", error: event.message });
        worker.postMessage({
          protocol: "tinta-host-1",
          documentId: "a".repeat(32),
          capability: "b".repeat(32),
          requestId: 1,
          sourceRevision: 1,
          kind: "compile",
          profile: "tinta",
          uri: "tinta:performance-large",
          source,
        });
      }),
    { code, source },
  );
}

// This runs in the browser. Completion promises avoid locator polling while
// the browser is processing an interaction or replacing the preview document.
export function installProbe() {
  const afterPaintOpportunity = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  const now = () => performance.timeOrigin + performance.now();
  const tasks = [];
  const observer = new PerformanceObserver((list) => {
    tasks.push(...list.getEntries());
  });
  if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    throw new Error("Long-task observation is unavailable");
  }
  observer.observe({ type: "longtask" });
  globalThis.interactionProbe = {
    armKey() {
      this.key = new Promise((resolve) => {
        window.addEventListener(
          "keydown",
          async (event) => {
            const start = performance.timeOrigin + event.timeStamp;
            await afterPaintOpportunity();
            resolve({ start, end: now(), trusted: event.isTrusted });
          },
          { capture: true, once: true },
        );
      });
    },
    armPreview(expectedText) {
      this.preview = new Promise((resolve) => {
        const host = document.querySelector("main");
        const changes = new MutationObserver(async () => {
          const article = host.querySelector("article");
          // Studio removes the reader toolbar; select content independently
          // of its position and exclude the accessible status region.
          const content = article?.querySelector(
            ":scope > div:not(.tinta-reader-actions):not(.tinta-reader-status)",
          );
          if (content?.lastElementChild?.textContent !== expectedText) return;
          changes.disconnect();
          await afterPaintOpportunity();
          resolve(now());
        });
        changes.observe(host, { childList: true, subtree: true });
      });
    },
    collect(start, end) {
      tasks.push(...observer.takeRecords());
      return tasks
        .filter((entry) => {
          const taskStart = performance.timeOrigin + entry.startTime;
          return taskStart < end && taskStart + entry.duration > start;
        })
        .map((entry) => ({
          start: performance.timeOrigin + entry.startTime,
          duration: entry.duration,
          context: entry.name,
        }));
    },
    clear() {
      tasks.length = 0;
      observer.takeRecords();
    },
  };
}

async function waitForMeasurement(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Studio measurement did not complete")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measureStudioRun(browser, source, run) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const typing = [];
  const controls = [];
  try {
    await page.goto(pathToFileURL(resolve("build/tinta-studio.html")).href);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "performance.tinta",
      mimeType: "text/plain",
      buffer: Buffer.from(source),
    });
    await page.frameLocator("iframe").getByRole("article").waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Document source" });
    await editor.press("ControlOrMeta+End");
    // Setup is outside measured intervals. The paragraph remains a cheap,
    // specific completion sentinel as each real key adds one character.
    await page.keyboard.insertText("\n\nMeasurement ");
    await page
      .frameLocator("iframe")
      .getByText("Measurement", { exact: true })
      .waitFor();
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    if (!frame) throw new Error("Studio preview frame is missing");
    await page.evaluate(installProbe);
    await frame.evaluate(installProbe);
    for (let index = 0; index < 60; index++) {
      await editor.focus();
      await page.evaluate(() => {
        globalThis.interactionProbe.clear();
        globalThis.interactionProbe.armKey();
      });
      await frame.evaluate(
        (expected) => {
          globalThis.interactionProbe.armPreview(expected);
        },
        `Measurement ${"x".repeat(index + 1)}`,
      );
      const completion = waitForMeasurement(
        Promise.all([
          page.evaluate(() => globalThis.interactionProbe.key),
          frame.evaluate(() => globalThis.interactionProbe.preview),
        ]),
      );
      const [[key, previewEnd]] = await Promise.all([
        completion,
        page.keyboard.press("x"),
      ]);
      if (!key.trusted) throw new Error("Typing event was not trusted");
      const tasks = await page.evaluate(
        ({ start, end }) => {
          return globalThis.interactionProbe.collect(start, end);
        },
        { start: key.start, end: previewEnd },
      );
      if (index >= 10) typing.push({ ...key, previewEnd, tasks });
    }
    // Query and focus before each timed interval; no locator search runs while
    // the dependent chart update or its paint opportunity is being measured.
    for (let index = 0; index < 60; index++) {
      const slider = frame.getByRole("slider", {
        name: "Answer 0",
        exact: true,
      });
      await slider.focus();
      const previousChart = await frame.locator("figure").first().textContent();
      await page.evaluate(() => globalThis.interactionProbe.clear());
      await frame.evaluate(() => globalThis.interactionProbe.armKey());
      const completion = waitForMeasurement(
        frame.evaluate(() => globalThis.interactionProbe.key),
      );
      const [key] = await Promise.all([
        completion,
        page.keyboard.press(index % 2 === 0 ? "ArrowRight" : "ArrowLeft"),
      ]);
      const value = await slider.inputValue();
      const updatedChart = await frame.locator("figure").first().textContent();
      if (
        !key.trusted ||
        value !== (index % 2 === 0 ? "2" : "1") ||
        previousChart === updatedChart
      ) {
        throw new Error("Control did not complete the expected trusted update");
      }
      const tasks = await page.evaluate(({ start, end }) => {
        return globalThis.interactionProbe.collect(start, end);
      }, key);
      if (index >= 10) controls.push({ ...key, tasks });
    }
    console.log(`Studio run ${run}: 50 typing and 50 control measurements`);
    return { typing, controls };
  } catch (error) {
    await mkdir("reports/verification", { recursive: true });
    await writeFile(
      `reports/verification/studio-run-${run}-failure.json`,
      JSON.stringify({ typing, controls, error: String(error) }, null, 2) +
        "\n",
    );
    throw error;
  } finally {
    await context.close();
  }
}

export async function measureStudio(browser, source) {
  const runs = [];
  for (let run = 1; run <= 3; run++) {
    const measured = await measureStudioRun(browser, source, run);
    runs.push(measured);
    await mkdir("reports/verification", { recursive: true });
    await writeFile(
      `reports/verification/studio-run-${run}.json`,
      JSON.stringify(measured, null, 2) + "\n",
    );
  }
  return {
    protocol: "interaction-paint-opportunity",
    warmup: 10,
    measured: 50,
    runs,
    ...assessStudioRuns(runs),
    limitations: [
      "Two animation frames measure a paint opportunity, not actual pixel presentation or field INP.",
      "Observed tasks include browser and measurement overhead; context attribution does not identify product functions.",
      "No automated DOM polling runs within timed intervals.",
    ],
  };
}
