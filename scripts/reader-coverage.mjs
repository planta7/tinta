import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseAstAsync } from "vite";

// Reuse the exact converter and coverage map shipped with the locked provider.
const provider = createRequire(import.meta.resolve("@vitest/coverage-v8"));
const { convert } = await import(provider.resolve("ast-v8-to-istanbul"));
const { createCoverageMap } = await import(
  provider.resolve("@vitest/istanbul-lib-coverage")
);

export async function readerCoverage(entries, mapPath) {
  const merged = createCoverageMap({});
  const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
  for (const entry of entries) {
    const converted = await convert({
      ast: parseAstAsync(entry.source),
      code: entry.source,
      coverage: entry,
      wrapperLength: 0,
      sourceMap,
    });
    for (const path of Object.keys(converted)) {
      if (!path.startsWith(resolve("packages/reader/src") + "/"))
        delete converted[path];
    }
    merged.merge(converted);
  }
  const paths = merged.files();
  const expected = ["index.ts", "policy.ts", "standalone.ts", "chart-view.ts"];
  if (
    expected.some(
      (name) => !paths.includes(resolve("packages/reader/src", name)),
    )
  ) {
    throw new Error("Missing reader source coverage.");
  }
  const summary = merged.getCoverageSummary().toJSON();
  await writeFile(
    "reports/verification/reader-coverage.json",
    JSON.stringify({ summary, files: merged.toJSON() }, null, 2) + "\n",
  );
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { summary } = JSON.parse(
    await readFile("reports/verification/reader-coverage.json", "utf8"),
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
