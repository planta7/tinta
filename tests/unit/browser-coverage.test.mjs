import { Session } from "node:inspector/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { build } from "esbuild";
import { parseAstAsync } from "vite";
import { expect, test } from "vitest";
import { readerCoverage } from "../../scripts/reader-coverage.mjs";
import { mergeBrowserCoverage } from "../../scripts/browser-coverage.mjs";

const provider = createRequire(import.meta.resolve("@vitest/coverage-v8"));
const { convert } = await import(provider.resolve("ast-v8-to-istanbul"));
const { createCoverageMap } = await import(
  provider.resolve("@vitest/istanbul-lib-coverage")
);

async function execution(source, url, flag) {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true,
    });
    const context = {};
    new Script(source, { filename: url }).runInNewContext(context);
    context.CoverageFixture.choose(flag);
    const { result } = await session.post("Profiler.takePreciseCoverage");
    const coverage = result.find((entry) => entry.url === url);
    expect(coverage).toBeDefined();
    return { ...coverage, source };
  } finally {
    session.disconnect();
  }
}

for (const distinctSources of [false, true]) {
  test(`browser coverage preserves independent execution counts with ${
    distinctSources ? "distinct sources" : "repeated bundles"
  }`, async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "tinta-coverage-")),
    );
    try {
      const input = join(directory, "fixture.ts");
      const output = join(directory, "bundle.js");
      await writeFile(
        input,
        "export function choose(flag: boolean) {\n" +
          "  if (flag) return 1;\n" +
          "  return 2;\n" +
          "}\n" +
          "export function untouched() { return 3; }\n",
      );
      await build({
        entryPoints: [input],
        outfile: output,
        bundle: true,
        format: "iife",
        globalName: "CoverageFixture",
        sourcemap: "external",
      });
      const source = await readFile(output, "utf8");
      const entries = [];
      for (const [index, flag] of [true, false, true].entries()) {
        entries.push(
          await execution(
            source + (distinctSources ? `\n// Execution ${index}\n` : ""),
            pathToFileURL(join(directory, `execution-${index}.js`)).href,
            flag,
          ),
        );
      }
      const original = structuredClone(entries);
      const sourceMap = JSON.parse(await readFile(output + ".map", "utf8"));
      sourceMap.sources = sourceMap.sources.map((path) =>
        resolve(dirname(output), path),
      );
      const expected = createCoverageMap({});
      const fragments = join(directory, "fragments");
      await mkdir(fragments);
      for (const [index, entry] of entries.entries()) {
        const converted = await convert({
          ast: parseAstAsync(entry.source),
          code: entry.source,
          coverage: entry,
          wrapperLength: 0,
          sourceMap,
        });
        expected.merge({ [input]: converted[input] });
        for (const runtime of ["browser", "preview"])
          await writeFile(
            join(fragments, `${runtime}-${index}.json`),
            JSON.stringify({ files: { [input]: converted[input] } }),
          );
      }
      await mergeBrowserCoverage(fragments, directory);
      for (const runtime of ["browser", "preview"]) {
        const merged = JSON.parse(
          await readFile(
            join(directory, `studio-${runtime}-coverage.json`),
            "utf8",
          ),
        );
        expect(merged.files).toEqual(
          JSON.parse(JSON.stringify(expected.toJSON())),
        );
        expect(merged.summary).toEqual(expected.getCoverageSummary().toJSON());
      }
      for (const index of entries.keys())
        await rm(join(fragments, `preview-${index}.json`));
      await expect(mergeBrowserCoverage(fragments, directory)).rejects.toThrow(
        "Missing Studio preview coverage fragments.",
      );
      const report = join(directory, "coverage.json");
      await readerCoverage(entries, output + ".map", {
        sourceRoot: directory,
        sources: ["fixture.ts"],
        report,
      });
      const actual = JSON.parse(await readFile(report, "utf8"));
      expect(actual.files).toEqual(
        JSON.parse(JSON.stringify(expected.toJSON())),
      );
      expect(actual.summary).toEqual(expected.getCoverageSummary().toJSON());
      expect(actual.summary.branches.pct).toBe(100);
      const file = actual.files[input];
      const functionCounts = Object.fromEntries(
        Object.entries(file.fnMap).map(([id, fn]) => [fn.name, file.f[id]]),
      );
      expect(functionCounts.choose).toBe(3);
      expect(functionCounts.untouched).toBe(0);
      expect(entries).toEqual(original);
      await expect(
        readerCoverage([], output + ".map", {
          sourceRoot: directory,
          sources: ["fixture.ts"],
          report,
        }),
      ).rejects.toThrow("Missing reader source coverage.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
