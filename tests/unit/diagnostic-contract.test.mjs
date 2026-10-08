import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { parse, enrichMarkdown } from "../../packages/syntax/dist/index.js";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  createAsset,
  normalizeAssetPath,
  openBundle,
  packSource,
  exportHtml,
  validateStateSnapshot,
  unwrap,
} from "../../packages/artifacts/dist/index.js";
import { attempt } from "../../packages/types/dist/common.js";
import { run } from "../../packages/cli/dist/index.js";

const input = (text) => ({ text, profile: "tinta", uri: "tinta:diagnostic" });
function code(result, expected) {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("value");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: expected })]),
  );
}

for (const [expected, source] of [
  ["E_DIRECTIVE_SYNTAX", "@slider"],
  ["E_PROPERTY_REQUIRED", '@data d\nx:number\n1\n@end\n@chart line d (y:"x")'],
  [
    "E_CHART_TYPE",
    '@data d\nx:number\n1\n@end\n@chart unknown d (x:"x",y:"x")',
  ],
]) {
  test(`diagnostic ${expected} identifies its malformed directive`, () => {
    code(compile(input(source)), expected);
  });
}

test("diagnostic E_NUMBER_RANGE rejects non-real evaluated power", () => {
  const program = unwrap(compile(input("{{ pow(-1, 0.5) }}")));
  code(createSession(program), "E_NUMBER_RANGE");
});

test("artifact diagnostics distinguish missing, external, malformed and unsafe images", async () => {
  const missing = unwrap(compile(input("![Missing](missing.png)")));
  const external = unwrap(
    compile(input("![Remote](https://example.invalid/a.png)")),
  );
  code(await packSource(missing, new Map()), "E_ASSET_MISSING");
  code(await packSource(external, new Map()), "E_ASSET_EXTERNAL");
  code(createAsset(new TextEncoder().encode("<svg/>")), "E_ASSET_TYPE");
  code(
    attempt(() => normalizeAssetPath("../private.png")),
    "E_ASSET_PATH",
  );
});

test("artifact diagnostics identify invalid bundles, snapshots and export options", async () => {
  const program = unwrap(compile(input("# Document")));
  const session = unwrap(createSession(program));
  try {
    code(await openBundle(Uint8Array.of(0)), "E_BUNDLE");
    code(validateStateSnapshot(program, {}), "E_SNAPSHOT");
    code(
      await exportHtml(session, new Map(), {
        format: "pdf",
        answers: "initial",
      }),
      "E_EXPORT_INVALID",
    );
  } finally {
    session.destroy();
  }
});

test("host diagnostics distinguish an existing output from a failed read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinta-diagnostics-"));
  try {
    const source = join(directory, "source.tinta");
    const output = join(directory, "existing.html");
    await writeFile(source, "# Source");
    await writeFile(output, "Keep me");
    const exists = await run([
      "build",
      source,
      "--format=static",
      "--output",
      output,
      "--json",
    ]);
    const missing = await run([
      "check",
      join(directory, "missing.tinta"),
      "--json",
    ]);
    expect(JSON.parse(exists.stdout).diagnostics[0].code).toBe(
      "E_OUTPUT_EXISTS",
    );
    expect(JSON.parse(missing.stdout).diagnostics[0].code).toBe("E_IO");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("internal artifact exceptions return a fixed diagnostic without exception content", () => {
  const result = attempt(() => {
    throw new Error("private source payload");
  });
  code(result, "E_INTERNAL");
  expect(JSON.stringify(result)).not.toContain("private source payload");
});

for (const [warning, source] of [
  ["W_NUL_REPLACED", "\0"],
  ["W_HTML_INERT", "<div>Inert</div>"],
  ["W_LINK_LOCAL_UNSUPPORTED", "[Other](other.tinta)"],
  ["W_LINK_UNSAFE", "[Unsafe](javascript:alert)"],
]) {
  test(`warning ${warning} preserves a successful parse`, () => {
    const result = parse(input(source));
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: warning, severity: "warning" }),
    );
  });
}

test("warning W_MARKDOWN_COLLISION accompanies explicit enrichment edits", () => {
  const result = enrichMarkdown({
    ...input("Literal {{ amount }}"),
    profile: "markdown",
  });
  expect(result.ok).toBe(true);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "W_MARKDOWN_COLLISION",
      severity: "warning",
    }),
  );
  expect(result.value.edits).toHaveLength(1);
});
