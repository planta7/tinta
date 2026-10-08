import { describe, it, expect, afterEach, afterAll } from "vitest";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  checkImport,
  inspectSource,
  checkWorkspace,
} from "../../scripts/architecture.mjs";
import { classicBundle, inlineScript } from "../../scripts/packaging.mjs";
import { requireCapability } from "../../scripts/capabilities.mjs";

const json = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("workspace capability boundaries", () => {
  it("checks the actual workspace", () => expect(checkWorkspace()).toBe(62));

  for (const [owner, dependency] of [
    ["engine", "node:fs"],
    ["types", "fs"],
    ["reader", "react"],
    ["artifacts", "@codemirror/view"],
    ["reader", "@tinta/studio"],
    ["engine", "@tinta/reader/internal"],
    ["types", "@tinta/engine"],
  ])
    it(`rejects ${owner} -> ${dependency}`, () =>
      expect(() => checkImport(owner, dependency)).toThrow());

  for (const source of [
    'import fs from "node:fs"',
    'export * from "react"',
    'import("x")',
    'eval("x")',
    'new Function("x")',
    'fetch("x")',
    "Date.now()",
    "document.body",
    "globalThis.document.body",
    "Math.random()",
  ])
    it(`rejects unsafe source ${source}`, () =>
      expect(() => inspectSource("engine", source)).toThrow());

  it("allows parser methods named document without granting DOM access", () => {
    expect(() =>
      inspectSource("syntax", "parser.document().write(chunks);"),
    ).not.toThrow();
  });

  it("permits approved pure engine subpaths in the geometry adapter", () =>
    expect(() =>
      checkImport("charts", "@tinta/engine/chart-presentation"),
    ).not.toThrow());

  it("allows type-only local imports and pure calculations", () =>
    expect(() =>
      inspectSource(
        "engine",
        'import type { X } from "./x.js"; export const a = 2 + 2;',
      ),
    ).not.toThrow());
});

describe("capability gates", () => {
  for (const suite of ["conformance", "browser"])
    it(`does not pretend ${suite} exists`, () => {
      expect(() => requireCapability(suite)).toThrow("NOT_IMPLEMENTED");
      const result = spawnSync(
        process.execPath,
        ["scripts/capabilities.mjs", suite],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("NOT_IMPLEMENTED");
    });

  it("allows explicitly selected infrastructure browser scope", () =>
    expect(() => requireCapability("browser", "infrastructure")).not.toThrow());
});

describe("registry and Ajv 2020 envelope checks, not IR validation", () => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });

  for (const name of ["state", "bundle", "import", "interactive-envelope"])
    ajv.addSchema(json(`schemas/${name}.schema.json`), `${name}.schema.json`);

  it("compiles all four schemas", () => {
    for (const name of ["state", "bundle", "import", "interactive-envelope"])
      expect(ajv.getSchema(`${name}.schema.json`)).toBeTypeOf("function");
  });

  it("preserves registry identity and unique closed enums", () => {
    const registry = json("spec/registry.json");
    expect(registry.contractRevision).toBe("1.0-draft.2");
    expect(registry.profiles).toEqual(["markdown", "tinta"]);

    for (const key of ["directives", "functions", "chartTypes"])
      expect(new Set(registry[key]).size).toBe(registry[key].length);
    expect(registry.chartTypes).toHaveLength(7);
  });

  for (const [name, value] of [
    ["state", json("examples/article.tinta.state.json")],
    [
      "import",
      {
        kind: "tinta-import-schema",
        columns: [{ input: "Name", name: "name", type: "text" }],
      },
    ],
    [
      "bundle",
      {
        kind: "tinta-source-bundle",
        formatVersion: "1.0",
        source: {
          path: "document.tinta",
          bytes: 0,
          sha256: "a".repeat(64),
        },
        assets: [],
      },
    ],
  ]) {
    it(`validates ${name}, rejects extra/missing/wrong-kind fields without mutation`, () => {
      const validate = ajv.getSchema(`${name}.schema.json`);
      const before = JSON.stringify(value);

      expect(validate(value)).toBe(true);
      expect(validate({ ...value, unknown: true })).toBe(false);
      expect(validate({ ...value, kind: "wrong" })).toBe(false);

      const missing = { ...value };
      delete missing.kind;
      expect(validate(missing)).toBe(false);

      expect(JSON.stringify(value)).toBe(before);
    });
  }

  it("rejects invalid state values and hashes", () => {
    const validate = ajv.getSchema("state.schema.json"),
      state = json("examples/article.tinta.state.json");

    for (const patch of [
      { controls: { x: null } },
      { controls: { x: {} } },
      { controls: [] },
      { sourceSha256: "bad" },
      { formatVersion: "9.0" },
    ])
      expect(validate({ ...state, ...patch })).toBe(false);
  });

  it("checks envelope references without claiming empty IR is valid", () => {
    const validate = ajv.getSchema("interactive-envelope.schema.json");
    const envelope = {
      kind: "tinta-interactive",
      formatVersion: "1.0",
      engineVersion: "0.0.0",
      abi: "tinta-ir-1",
      program: {},
      baseline: json("examples/article.tinta.state.json"),
      assets: [],
    };

    expect(validate(envelope)).toBe(true);
    expect(validate({ ...envelope, baseline: {} })).toBe(false);
    expect(validate({ ...envelope, abi: "wrong" })).toBe(false);
  });
});

describe("real dependencies and packaging", () => {
  for (const owner of ["syntax", "engine", "charts", "artifacts", "studio"])
    it(`imports ${owner} production helpers in Node`, async () => {
      const base =
        (owner === "studio" ? "apps/" : "packages/") + owner + "/package.json";
      const require = createRequire(join(process.cwd(), base));

      for (const name of Object.keys(json(base).dependencies).filter(
        (n) => !n.startsWith("@tinta/"),
      )) {
        const specifier =
          name === "@noble/hashes" ? "@noble/hashes/sha2.js" : name;
        const module = await import(
          pathToFileURL(require.resolve(specifier)).href
        );
        expect(Object.keys(module).length).toBeGreaterThan(0);
      }
    });

  it("bundles a dependency into one classic script with no external imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tinta-packaging-"));
    try {
      writeFileSync(join(dir, "value.ts"), "export const value = 42;");
      writeFileSync(
        join(dir, "entry.ts"),
        'import {value} from "./value.js"; globalThis.foundationValue = value;',
      );

      const bundle = await classicBundle(join(dir, "entry.ts"));
      expect(bundle.inputs).toHaveLength(2);
      expect(bundle.code).toContain("42");
      expect(bundle.code).not.toMatch(/^import /m);
      expect(inlineScript("</ScRiPt><!--")).toBe(
        "<script><\\/script><\\!--</script>",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates missing-entry build errors", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { classicBundle } from "./scripts/packaging.mjs"; ' +
          'await classicBundle("/nonexistent/tinta-entry.ts");',
      ],
      { encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Could not resolve "/nonexistent/tinta-entry.ts"',
    );
    expect(result.stdout).toBe("");
  });
});

it("reports an explicit nonzero status for unsupported capabilities", async () => {
  const { capabilityExitCode } = await import("../../scripts/capabilities.mjs");
  const messages = [];
  expect(
    capabilityExitCode("conformance", "evaluation", (m) => messages.push(m)),
  ).toBe(1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("NOT_IMPLEMENTED");
  expect(
    capabilityExitCode("browser", "infrastructure", (m) => messages.push(m)),
  ).toBe(0);
  expect(messages).toHaveLength(1);
});

const assertions = [];

afterEach(() => {
  const state = expect.getState();
  assertions.push({
    test: state.currentTestName,
    assertions: state.assertionCalls,
  });
});

afterAll(() => {
  mkdirSync("reports/verification", { recursive: true });
  writeFileSync(
    "reports/verification/unit-assertions.json",
    JSON.stringify(assertions, null, 2) + "\n",
  );
});
