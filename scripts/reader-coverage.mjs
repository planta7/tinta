import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { parseAstAsync } from "vite";

// Reuse the exact converter and coverage map shipped with the locked provider.
const provider = createRequire(import.meta.resolve("@vitest/coverage-v8"));
const { convert } = await import(provider.resolve("ast-v8-to-istanbul"));
const { createCoverageMap } = await import(
  provider.resolve("@vitest/istanbul-lib-coverage")
);
const { mergeScriptCovs } = await import(provider.resolve("@bcoe/v8-coverage"));

export async function readerCoverage(entries, mapPath, options = {}) {
  const sourceRoot = options.sourceRoot ?? "packages/reader/src";
  const expected = options.sources ?? [
    "index.ts",
    "policy.ts",
    "standalone.ts",
    "chart-view.ts",
  ];
  const report = options.report ?? "reports/verification/reader-coverage.json";
  const merged = createCoverageMap({});
  const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
  sourceMap.sources = sourceMap.sources.map((source) =>
    resolve(dirname(mapPath), sourceMap.sourceRoot ?? "", source),
  );
  delete sourceMap.sourceRoot;

  // Merge repeated executions before parsing and mapping the same bundle,
  // as the locked Vitest coverage provider does for each script.
  const scripts = new Map();
  for (const entry of entries) {
    const script = {
      ...entry,
      functions: structuredClone(entry.functions),
    };
    const previous = scripts.get(entry.source);
    const coverage = mergeScriptCovs(previous ? [previous, script] : [script]);
    scripts.set(entry.source, { ...coverage, source: entry.source });
  }

  for (const entry of scripts.values()) {
    const converted = await convert({
      ast: parseAstAsync(entry.source),
      code: entry.source,
      coverage: entry,
      wrapperLength: 0,
      sourceMap,
    });
    for (const path of Object.keys(converted)) {
      if (!expected.some((name) => path === resolve(sourceRoot, name)))
        delete converted[path];
    }
    merged.merge(converted);
  }
  const paths = merged.files();
  if (expected.some((name) => !paths.includes(resolve(sourceRoot, name)))) {
    throw new Error("Missing reader source coverage.");
  }
  const summary = merged.getCoverageSummary().toJSON();
  await writeFile(
    report,
    JSON.stringify({ summary, files: merged.toJSON() }, null, 2) + "\n",
  );
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { summary } = JSON.parse(
    await readFile(
      process.argv[2] ?? "reports/verification/reader-coverage.json",
      "utf8",
    ),
  );
  for (const [kind, minimum] of Object.entries({
    statements: 85,
    branches: 80,
    functions: 85,
    lines: 85,
  })) {
    if (summary[kind].pct < minimum)
      throw new Error(
        `Reader ${kind} coverage ${summary[kind].pct}% is below ${minimum}%`,
      );
  }
  console.log("Reader coverage PASS", summary);
}
