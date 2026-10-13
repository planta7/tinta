import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const provider = createRequire(import.meta.resolve("@vitest/coverage-v8"));
const { createCoverageMap } = await import(
  pathToFileURL(provider.resolve("@vitest/istanbul-lib-coverage")).href
);
const merged = createCoverageMap({});
const workerPath = resolve("apps/studio/dist/worker.js");
const unit = JSON.parse(await readFile("coverage/coverage-final.json", "utf8"));
if (!unit[workerPath]) throw new Error("Missing compiler worker coverage.");
merged.addFileCoverage(unit[workerPath]);

// Browser and unit transforms have different statement maps. Assign each
// authored module to one runtime so generated statement ranges are not counted twice.
for (const path of [
  "reports/verification/studio-browser-coverage.json",
  "reports/verification/studio-preview-coverage.json",
]) {
  const report = JSON.parse(await readFile(path, "utf8"));
  merged.merge(report.files ?? report);
}
const expected = (await readdir("apps/studio/dist"))
  .filter((name) => name.endsWith(".js") && name !== "studio-runtime.js")
  .map((name) => resolve("apps/studio/dist", name));
for (const path of expected) {
  if (!merged.files().includes(path))
    throw new Error(`Missing coverage: ${path}`);
}
const summary = merged.getCoverageSummary().toJSON();
const html = await readFile("build/tinta-studio.html");
const gzipBytes = gzipSync(html).length;
await writeFile(
  "reports/verification/studio-coverage.json",
  JSON.stringify({ summary, gzipBytes, files: merged.toJSON() }, null, 2) +
    "\n",
);
for (const [kind, minimum] of Object.entries({
  statements: 85,
  branches: 80,
  functions: 85,
  lines: 85,
})) {
  if (summary[kind].pct < minimum)
    throw new Error(
      `Studio ${kind} coverage ${summary[kind].pct}% is below ${minimum}%`,
    );
}
if (gzipBytes > 3 * 1024 * 1024)
  throw new Error("Studio exceeds its gzip byte ceiling.");
console.log("Studio coverage and size PASS", { summary, gzipBytes });
