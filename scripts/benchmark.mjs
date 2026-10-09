import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus, totalmem, platform, arch, release } from "node:os";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { measureWorker, measureStudio } from "./performance-browser.mjs";
import { performanceCorpus } from "./performance-corpus.mjs";
import { performanceExitCode } from "./qualification-policy.mjs";

const supplementary =
  process.argv.length === 3 && process.argv[2] === "--supplementary";
if (process.argv.length !== 2 && !supplementary)
  throw new Error("Usage: node scripts/benchmark.mjs [--supplementary]");

const directory = resolve("build/performance");
await mkdir(directory, { recursive: true });
await mkdir("reports/verification", { recursive: true });
const corpus = performanceCorpus();
for (const item of corpus)
  await writeFile(`${directory}/${item.name}.tinta`, item.source);
await writeFile(
  `${directory}/corpus.json`,
  JSON.stringify(
    corpus.map(({ name, seed, bytes, sha256 }) => ({
      name,
      seed,
      bytes,
      sha256,
    })),
    null,
    2,
  ),
);
await build({
  entryPoints: ["tests/browser/performance-harness.mjs"],
  outfile: `${directory}/harness.js`,
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
const css = await readFile("packages/reader/src/reader.css", "utf8");
await writeFile(
  `${directory}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Performance corpus</title><style>${css}</style><main></main><script src="harness.js"></script></html>`,
);
const environment = {
  utc: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  os: release(),
  cpu: cpus()[0]?.model,
  ramBytes: totalmem(),
  power:
    platform() === "darwin"
      ? execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" })
      : "UNAVAILABLE",
  powerMode:
    platform() === "darwin"
      ? execFileSync("pmset", ["-g", "custom"], { encoding: "utf8" })
      : "UNAVAILABLE",
  throttling: "No artificial CPU throttle configured",
};
const browser = await chromium.launch();
environment.browser = browser.version();
const results = [];
const url = pathToFileURL(`${directory}/index.html`).href;
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
try {
  const page = await browser.newPage();
  await page.context().setOffline(true);
  await page.goto(url);
  for (const item of corpus) {
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const value = await page.evaluate(
        (source) => globalThis.performanceTest.sample(source),
        item.source,
      );
      if (i >= 10) samples.push(value);
    }
    const metrics = Object.fromEntries(
      Object.keys(samples[0])
        .filter((key) => typeof samples[0][key] === "number")
        .map((key) => [
          key,
          distribution(samples.map((sample) => sample[key])),
        ]),
    );
    const budgets =
      item.name === "small"
        ? { initial: 150, update: 50 }
        : item.name === "medium"
          ? { initial: 750, update: 150, export: 2000 }
          : item.name === "dense"
            ? { geometryAndMount: 250, update: 250 }
            : item.name === "large"
              ? { compile: 3000 }
              : {};
    const checks = Object.entries(budgets).map(([metric, limit]) => ({
      metric,
      limit,
      actual: metrics[metric]?.p95,
      pass: metrics[metric]?.p95 <= limit,
    }));
    results.push({
      name: item.name,
      sha256: item.sha256,
      metrics,
      checks,
      diagnostics: samples[0].diagnostics ?? [],
    });
    console.log(item.name, checks);
  }
  const cold = [];
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext({ offline: true });
    const fresh = await context.newPage();
    await fresh.goto(url);
    cold.push(
      await fresh.evaluate(
        (source) => globalThis.performanceTest.sample(source),
        corpus.find((item) => item.name === "small").source,
      ),
    );
    await context.close();
  }
  const cdp = await page.context().newCDPSession(page);
  const small = corpus.find((item) => item.name === "small").source;
  await page.evaluate(
    (source) => globalThis.performanceTest.cycles(source, 10),
    small,
  );
  await cdp.send("HeapProfiler.collectGarbage");
  const before = await cdp.send("Runtime.getHeapUsage");
  await page.evaluate(
    (source) => globalThis.performanceTest.cycles(source, 100),
    small,
  );
  await cdp.send("HeapProfiler.collectGarbage");
  const after = await cdp.send("Runtime.getHeapUsage");
  const memory = {
    before,
    after,
    retained: after.usedSize - before.usedSize,
    maximum: 10 * 1024 * 1024,
  };
  await writeFile(
    "reports/verification/performance.json",
    JSON.stringify(
      {
        status: "IN_PROGRESS",
        environment,
        warmup: 10,
        measured: 50,
        results,
        cold,
        memory,
      },
      null,
      2,
    ) + "\n",
  );
  const worker = await measureWorker(
    page,
    corpus.find((item) => item.name === "large").source,
  );
  const studio = await measureStudio(
    browser,
    corpus.find((item) => item.name === "medium").source,
  );
  const workerPass =
    worker.status === "RESPONSE" &&
    worker.elapsed <= 3000 &&
    worker.response.kind === "rejected" &&
    worker.response.diagnostics?.[0]?.code === "E_LIMIT";
  const pass =
    workerPass &&
    studio.pass &&
    results.every((result) => result.checks.every((check) => check.pass)) &&
    memory.retained <= memory.maximum;
  const complete =
    results.length === corpus.length &&
    results.every(({ metrics }) =>
      Object.values(metrics).every(
        ({ samples }) =>
          samples.length === 50 && samples.every(Number.isFinite),
      ),
    ) &&
    cold.length === 10 &&
    Number.isFinite(memory.retained) &&
    Number.isFinite(worker.elapsed) &&
    worker.status === "RESPONSE" &&
    worker.response.kind === "rejected" &&
    worker.response.diagnostics?.[0]?.code === "E_LIMIT" &&
    studio.runs.length === 3 &&
    studio.summaries.every((summary) => !summary.reason);
  await writeFile(
    "reports/verification/performance.json",
    JSON.stringify(
      {
        status: pass ? "MEASURED_TARGETS_PASS" : "FAIL",
        measurementStatus: complete ? "COMPLETE" : "FAIL",
        role: supplementary ? "SUPPLEMENTARY" : "REFERENCE",
        environment,
        warmup: 10,
        measured: 50,
        results,
        cold,
        memory,
        worker,
        studio,
        limitations: [
          "Reference power mode and environment require reviewer confirmation.",
          "Cold samples include compilation/evaluation after fresh-context harness loading, not total artifact navigation time.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = performanceExitCode({ pass, complete, supplementary });
} catch (error) {
  await writeFile(
    "reports/verification/performance-failure.json",
    JSON.stringify(
      {
        status: "FAIL",
        environment,
        results,
        error: String(error),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
}
