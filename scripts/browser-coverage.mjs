import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fragmentDirectory } from "./browser-coverage-setup.mjs";

const provider = createRequire(import.meta.resolve("@vitest/coverage-v8"));
const { createCoverageMap } = await import(
  provider.resolve("@vitest/istanbul-lib-coverage")
);

export async function mergeBrowserCoverage(directory, outputDirectory) {
  const names = await readdir(directory);
  if (!names.length) return;
  for (const runtime of ["browser", "preview"]) {
    const fragments = names.filter((name) => name.startsWith(runtime + "-"));
    if (!fragments.length)
      throw new Error(`Missing Studio ${runtime} coverage fragments.`);
    const merged = createCoverageMap({});
    for (const name of fragments.sort()) {
      const report = JSON.parse(await readFile(join(directory, name), "utf8"));
      merged.merge(report.files);
    }
    await writeFile(
      join(outputDirectory, `studio-${runtime}-coverage.json`),
      JSON.stringify(
        {
          summary: merged.getCoverageSummary().toJSON(),
          files: merged.toJSON(),
        },
        null,
        2,
      ) + "\n",
    );
  }
}

export default async function teardown() {
  await mergeBrowserCoverage(fragmentDirectory, "reports/verification");
}
