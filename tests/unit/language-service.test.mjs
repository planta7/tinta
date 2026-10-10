import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { classicBundle } from "../../scripts/packaging.mjs";
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { propertyRuns } from "../support/properties.mjs";
import {
  analyze,
  catalog,
  completion,
  definition,
  help,
  references,
} from "../../packages/language-service/dist/index.js";
import {
  analyzeProgram,
  compile,
  createSession,
  decodeProgram,
  encodeProgram,
} from "../../packages/engine/dist/index.js";
import {
  editingSite,
  parseRecovering,
} from "../../packages/syntax/dist/index.js";

const version = {
  documentInstance: "a".repeat(32),
  editorVersion: 1,
  sourceRevision: 0,
};
const input = (text, profile = "tinta") => ({
  text,
  profile,
  uri: "tinta:language-service",
});

function snapshot(text, profile = "tinta", options) {
  const result = analyze(input(text, profile), version, options);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.value;
}

function context(marked, profile = "tinta") {
  const offset = marked.indexOf("¦");
  const source = marked.replace("¦", "");
  return completion(snapshot(source, profile), offset);
}

function direct(source, options) {
  const compiled = compile(source, options);
  if (!compiled.ok) return { valid: false, diagnostics: compiled.diagnostics };
  const session = createSession(compiled.value);
  if (!session.ok) return { valid: false, diagnostics: session.diagnostics };
  session.value.destroy();
  return { valid: true, diagnostics: compiled.diagnostics };
}

const table = "@data records\nname:text | value:number\nA | 2\n@end\n";

describe("portable analysis", () => {
  const cases = JSON.parse(
    readFileSync("conformance/cases.json", "utf8"),
  ).cases;
  for (const item of cases.filter((item) => typeof item.source === "string")) {
    test(`agrees with direct initial checks for ${item.id}`, () => {
      const source = input(item.source, item.profile ?? "tinta");
      const expected = direct(source);
      const actual = analyze(source, version);
      expect(actual.diagnostics).toEqual(expected.diagnostics);
      expect(actual.ok && actual.value.validity === "valid").toBe(
        expected.valid,
      );
    });
  }

  test("preserves exact bytes, identities and immutable detached output", () => {
    const text = "\uFEFF@let amount = 3\r\n# 😀\r{{ ((amount)) }}\n";
    const bytes = new TextEncoder().encode(text);
    const result = analyze({ ...input(""), text: undefined, bytes }, version);
    expect(result.ok).toBe(true);
    const value = result.value;
    expect(value.sourceText).toBe(text);
    expect(value.identity.sourceSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    bytes.fill(0);
    expect(value.sourceText).toBe(text);
    expect(() => {
      value.symbols[0].name = "changed";
    }).toThrow();
    expect(() => {
      value.identity.editorVersion = 2;
    }).toThrow();
    const offset = text.lastIndexOf("amount");
    expect(definition(value, offset)).toEqual(value.symbols[0].selection);
    expect(
      text.slice(
        value.references[0].span.start.offset,
        value.references[0].span.end.offset,
      ),
    ).toBe("amount");
    expect(value.references[0].span.start).toEqual({
      offset,
      line: 3,
      column: 6,
    });
    expect(completion(structuredClone(value), offset)).toEqual(
      completion(value, offset),
    );
    const next = analyze(input("@let amount = 4"), {
      ...version,
      editorVersion: 2,
      sourceRevision: 1,
    });
    expect(next.value.identity.sourceSha256).not.toBe(
      value.identity.sourceSha256,
    );
    expect(value.identity.editorVersion).toBe(1);
  });

  test("uses compiler types without extending serialized IR", () => {
    const source = input(
      `${table}@view subset = records\n@let empty = []\n@let values = [1, 2]\n@calc future = later + 1\n@let later = 3\n`,
    );
    const compiled = compile(source);
    expect(compiled.ok).toBe(true);
    const encoded = encodeProgram(compiled.value);
    const facts = analyzeProgram(compiled.value);
    expect(facts.find((item) => item.name === "empty").type).toEqual({
      kind: "list",
      scalar: "never",
    });
    expect(facts.find((item) => item.name === "subset").type.columns).toEqual([
      { name: "name", type: "text" },
      { name: "value", type: "number" },
    ]);
    expect(facts.find((item) => item.name === "future").type).toEqual({
      kind: "scalar",
      scalar: "number",
    });
    expect(analyzeProgram(decodeProgram(encoded).value)).toEqual(facts);
    expect(encodeProgram(compiled.value)).toEqual(encoded);
    expect(() => analyzeProgram({})).toThrow(TypeError);
    expect(() => {
      facts[0].type.columns[0].name = "changed";
    }).toThrow();
  });

  test("does not fabricate semantic facts for partial or duplicate bindings", () => {
    for (const text of [
      "@let x = 1\n@calc bad =\n{{ x }}",
      "@let x = 1\n@let x = 2\n{{ x }}",
      "@calc x = missing\n{{ x }}",
    ]) {
      const value = snapshot(text);
      expect(value.validity).toBe("invalid");
      expect(value.completeness).toBe("partial");
      expect(value.references).toEqual([]);
      expect(value.symbols.every((item) => item.type === undefined)).toBe(true);
      expect(definition(value, text.lastIndexOf("x"))).toBeUndefined();
    }
    const value = snapshot("@let x = 1\n@calc bad =\n@let later = pow(2, 3)");
    expect(value.symbols.map((item) => item.name)).toContain("later");
    expect(help(value, value.sourceText.indexOf("pow")).signatures).toEqual([
      catalog.signatures.pow,
    ]);
    expect(help(value, value.sourceText.indexOf("later")).text).toContain(
      "type unavailable",
    );
  });

  test("initial evaluation failure never enables validity", () => {
    const value = snapshot(
      "@slider denominator = 0\n@calc value = 1 / denominator",
    );
    expect(value.completeness).toBe("semantic");
    expect(value.validity).toBe("invalid");
    expect(value.diagnostics[0].code).toBe("E_DIV_ZERO");
    expect(
      value.symbols.find((item) => item.name === "value").type.scalar,
    ).toBe("number");
  });

  test("rejects acquisition and resource failures without partial success", () => {
    for (const source of [
      input("\ud800"),
      { uri: "tinta:bad", profile: "tinta", bytes: Uint8Array.of(255) },
    ]) {
      const result = analyze(source, version);
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual(compile(source).diagnostics);
    }
    for (const limits of [
      { sourceBytes: 3 },
      { astNodes: 1 },
      { compileOperations: 1 },
      { sourceBytes: 9999999 },
    ]) {
      const source = input("@let amount = 3");
      const result = analyze(source, version, { limits });
      expect(result.diagnostics).toEqual(
        compile(source, { limits }).diagnostics,
      );
      expect(result.ok).toBe(false);
    }
    for (const changes of [
      { documentInstance: "bad" },
      { editorVersion: 0 },
      { sourceRevision: -1 },
      { editorVersion: NaN },
    ]) {
      expect(() => analyze(input(""), { ...version, ...changes })).toThrow(
        TypeError,
      );
    }
    expect(() =>
      analyze({ ...input(""), uri: "x".repeat(4097) }, version),
    ).toThrow(TypeError);
    expect(() => analyze(input("", "unknown"), version)).toThrow(TypeError);
  });
});

describe("parser-owned contexts", () => {
  test.each([
    ["@¦", "directive", "chart"],
    ["@sl¦", "directive", "slider"],
    ["@slider amount = ¦", "literal", "0"],
    ["@slider amount = -1 (¦", "option", "min"],
    ["@slider amount = 1 (min: 0, la¦", "option", "label"],
    ["@toggle enabled = ¦", "literal", "true"],
    ['@choice answer = "A" (options: ¦', "literal", '["First", "Second"]'],
    ["@meta (locale: ¦", "literal", '"es-ES"'],
    ["@meta (currency: ¦", "literal", '"USD"'],
    ["@meta (version: ¦", "literal", '"1.0"'],
    ["@meta (title: ¦", "literal", '"Text"'],
    ["@details ¦", "literal", '"Text"'],
    ["@chart ¦", "literal", "bar"],
    ["@calc value = po¦", "expression", "pow"],
    ["@when ¦", "expression", "true"],
    ["{{ po¦", "expression", "pow"],
    ["{{ po¦ }}", "expression", "pow"],
    [`${table}@table rec¦`, "expression", "records"],
    [`${table}@chart bar rec¦`, "expression", "records"],
    [`${table}@view subset = rec¦`, "expression", "records"],
    [`${table}@view subset = records (where: row.¦`, "column", "value"],
    [`${table}@chart bar records (x: "name", y: row.va¦`, "column", "value"],
    [`${table}@chart bar records (x: "na¦")`, "column", '"name"'],
    [`${table}@view subset = records (sort: "va¦")`, "column", '"value"'],
    [`${table}@view subset = records (descending: ¦`, "literal", "true"],
    [
      `@slider selected = 1\n${table}@chart bar records (select: sel¦`,
      "selection",
      "selected",
    ],
  ])("queries %s", (source, kind, name) => {
    const result = context(source);
    expect(result.kind).toBe(kind);
    expect(result.allowedNames).toContain(name);
    expect(Object.isFrozen(result.allowedNames)).toBe(true);
  });

  test.each([
    "`{{ po¦ }}`",
    "```\n@sl¦\n```",
    "    @sl¦",
    "<!-- @sl¦ -->",
    "<div>\n@sl¦\n</div>",
    "\\@sl¦",
    "\\{{ po¦ }}",
    "[link](https://example.test/{{po¦}})",
    "![{{po¦}}](image.png)",
    "Text @sl¦",
    "> @sl¦",
    "- @sl¦",
    "{{ 1 }}¦",
    '@let text = "po¦"',
    "@data records\nname:text\n@sl¦\n@end",
  ])("keeps literal and forbidden regions inactive: %s", (source) => {
    expect(context(source).kind).toBe("none");
  });

  test("respects Markdown mode and excludes used options and ambiguous globals", () => {
    expect(context("@sl¦", "markdown").kind).toBe("none");
    expect(context("{{ po¦ }}", "markdown").allowedNames).toEqual([]);
    expect(context("@slider amount = 1 (min: 0, ¦").allowedNames).not.toContain(
      "min",
    );
    expect(
      context("@let x = 1\n@let x = 2\n{{ ¦ }}").allowedNames,
    ).not.toContain("x");
    expect(context("@slider x = 1\n@let y = ¦").allowedNames).not.toContain(
      "x",
    );
    const value = snapshot("@let x = 1");
    for (const offset of [-1, Infinity, 0.5, 100]) {
      expect(() => completion(value, offset)).toThrow(RangeError);
    }
  });
});

test("navigation selects only exact bound tokens", () => {
  const text = `${table}@view subset = records (where: row.value > 0)\n@calc total = sum(subset, "value")\n{{ ((total)) }}\n\ntotal records\n\n\`{{ total }}\`\n`;
  const value = snapshot(text);
  expect(value.validity).toBe("valid");
  const total = value.symbols.find((item) => item.name === "total");
  const refs = references(value, total.id);
  expect(refs).toHaveLength(1);
  expect(text.slice(refs[0].start.offset, refs[0].end.offset)).toBe("total");
  expect(definition(value, refs[0].start.offset)).toEqual(total.selection);
  expect(definition(value, text.lastIndexOf("total"))).toBeUndefined();
  expect(help(value, text.indexOf("sum")).signatures).toEqual([
    catalog.signatures.sum,
  ]);
  expect(help(value, text.indexOf("@view")).text).toContain("schema");
  expect(help(value, text.indexOf("where")).text).toContain("option");
  expect(help(value, text.indexOf("total")).text).toBe("total: number");
  expect(help(value, text.lastIndexOf("records"))).toBeUndefined();
  expect(references(value, "unknown")).toEqual([]);
  for (const token of value.tokens) {
    expect(token.span.start.offset).toBeGreaterThanOrEqual(0);
    expect(token.span.end.offset).toBeLessThanOrEqual(text.length);
  }
});

test("catalog names, options and signatures agree with normative sources", () => {
  const registry = JSON.parse(readFileSync("spec/registry.json", "utf8"));
  expect(catalog.directives).toEqual(registry.directives);
  expect(Object.keys(catalog.options)).toEqual(registry.directives);
  expect(Object.keys(catalog.signatures)).toEqual(registry.functions);
  const functions = readFileSync("spec/02_EXPRESSIONS_AND_STATE.md", "utf8");
  for (const signature of Object.values(catalog.signatures)) {
    expect(functions).toContain(signature);
  }
  for (const name of registry.directives) {
    expect(catalog.descriptions[name].length).toBeGreaterThan(20);
  }
});

test("bounded malformed input stays deterministic with exact spans", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "@",
          "{",
          "}",
          "(",
          ")",
          "[",
          "]",
          '"',
          "a",
          "1",
          "\n",
          "\r",
          "😀",
          " ",
        ),
        { maxLength: 80 },
      ),
      fc.constantFrom("tinta", "markdown"),
      (parts, profile) => {
        const text = parts.join("");
        const source = input(text, profile);
        const first = analyze(source, version);
        expect(analyze(source, version)).toEqual(first);
        const expected = direct(source);
        expect(first.diagnostics).toEqual(expected.diagnostics);
        if (!first.ok) return;
        expect(first.value.validity === "valid").toBe(expected.valid);
        for (const offset of [0, Math.floor(text.length / 2), text.length]) {
          const result = completion(first.value, offset);
          expect(result.replacement.start.offset).toBeGreaterThanOrEqual(0);
          expect(result.replacement.end.offset).toBeLessThanOrEqual(
            text.length,
          );
          expect(result.replacement.start.offset).toBeLessThanOrEqual(
            result.replacement.end.offset,
          );
        }
        const parsed = parseRecovering(source);
        expect(
          editingSite(parsed.value, 0).replacement.start.offset,
        ).toBeGreaterThanOrEqual(0);
      },
    ),
    { numRuns: propertyRuns, seed: 2048 },
  );
});

test("catalog cannot mutate the parser's normative names or options", () => {
  expect(() => catalog.options.slider.push("script")).toThrow();
  expect(() => catalog.directives.push("script")).toThrow();
  expect(compile(input("@script source")).ok).toBe(false);
});

test.each(["\n", "\r", "\r\n"])(
  "grouped identifiers retain exact positions across %j",
  (ending) => {
    const source = [
      "@let amount = 2",
      "@calc result = (",
      "  amount",
      ")",
      "{{ result }}",
    ].join(ending);
    const value = snapshot(source);
    expect(value.validity).toBe("valid");
    const offset = source.indexOf("amount", source.indexOf("@calc"));
    const reference = value.references.find(
      (item) => item.span.start.offset === offset,
    );
    expect(reference.span.start).toEqual({ offset, line: 3, column: 3 });
    expect(reference.span.end).toEqual({
      offset: offset + 6,
      line: 3,
      column: 9,
    });
  },
);

test("type help covers lists, schemas and partial declarations", () => {
  const source = `${table}@view subset = records\n@let items = [1, 2]\n{{ count(items) }}\n`;
  const value = snapshot(source);
  expect(help(value, source.indexOf("records")).text).toBe(
    "records: table<name: text, value: number>",
  );
  expect(help(value, source.indexOf("items")).text).toBe("items: list<number>");
  expect(help(value, source.indexOf("2]"))).toBeUndefined();
});

test("column queries use validated views and refuse unknown or ambiguous tables", () => {
  const complete = `${table}@view subset = records\n@chart bar subset (x: "name", y: row.value)\n`;
  const value = snapshot(complete);
  const offset = complete.lastIndexOf("value") + 2;
  expect(completion(value, offset).allowedNames).toEqual(["name", "value"]);
  expect(context('@chart bar missing (x: "na¦")').allowedNames).toEqual([]);
  expect(
    context(`${table}${table}@chart bar records (x: "na¦")`).allowedNames,
  ).toEqual([]);
  expect(
    context('@let records = 1\n@chart bar records (x: "na¦")').allowedNames,
  ).toEqual([]);
  expect(help(value, complete.lastIndexOf("value"))).toBeUndefined();
});

test.each([
  ["@slider amount = 1 (min: ¦", "0"],
  ["@slider amount = 1 (max: ¦", "1"],
  ["@slider amount = 1 (step: ¦", "1"],
  ["@chart histogram records (bins: ¦", "8"],
  ["@choice answer = ¦", '"Text"'],
  ["@table records (title: ¦", '"Text"'],
])("literal contexts never offer global expressions: %s", (source, literal) => {
  const result = context(source);
  expect(result.kind).toBe("literal");
  expect(result.allowedNames).toContain(literal);
  expect(result.allowedNames).not.toContain("pow");
});

test("option context survives nested expressions and multiline lists", () => {
  const source = `${table}@chart bar records (y: pow(row.value, 2), ¦`;
  const result = context(source);
  expect(result.kind).toBe("option");
  expect(result.allowedNames).toContain("x");
  expect(result.allowedNames).not.toContain("y");
  expect(
    context('@choice answer = "A" (\noptions: ["A", "B"],\n¦').allowedNames,
  ).toEqual(["label"]);
  expect(context("@slider amount = 1 (unknown: ¦").kind).toBe("none");
  expect(context('@slider amount = 1 (label: "Name") ¦').kind).toBe("none");
  expect(context("@calc ¦").kind).toBe("none");
  expect(context("@view ¦").kind).toBe("none");
  expect(context("@toggle ¦").kind).toBe("none");
});

test("tokenizes closing and malformed directive heads without claiming validity", () => {
  const source = "@when true\nBody\n@end\n@slider broken =\n";
  const value = snapshot(source);
  const heads = value.tokens
    .filter((item) => item.kind === "directive")
    .map((item) => source.slice(item.span.start.offset, item.span.end.offset));
  expect(heads).toEqual(["@when", "@end", "@slider"]);
  expect(value.validity).toBe("invalid");
  expect(help(value, source.indexOf("@end")).text).toContain("innermost");
  expect(help(value, source.indexOf("@slider")).text).toContain("Numeric");
  expect(help(snapshot("@unknown thing"), 0)).toBeUndefined();
});

test("marks column operands separately from arbitrary string literals", () => {
  const source = `${table}@view subset = records (sort: "value")\n@chart bar subset (x: "name", y: ["value"], title: "value")\n@calc total = sum(subset, "value")\n`;
  const value = snapshot(source);
  expect(value.validity).toBe("valid");
  const operands = value.tokens
    .filter((item) => item.kind === "column")
    .map((item) => source.slice(item.span.start.offset, item.span.end.offset));
  expect(operands).toEqual([
    "name",
    "value",
    '"value"',
    '"name"',
    '"value"',
    '"value"',
  ]);
  expect(
    value.tokens.find(
      (item) =>
        item.span.start.offset ===
        source.indexOf('"value"', source.indexOf("title:")),
    ).kind,
  ).toBe("literal");
});

test("portable worker bundle runs without host capabilities", async () => {
  const bundle = await classicBundle(
    "packages/language-service/src/index.ts",
    "PortableLanguageService",
    "neutral",
  );
  expect(
    bundle.inputs.every((path) => !/react|codemirror|node:/.test(path)),
  ).toBe(true);
  const context = {};
  runInNewContext(bundle.code, context, { timeout: 1000 });
  const result = context.PortableLanguageService.analyze(
    input("@let amount = 3\n{{ amount }}"),
    version,
  );
  expect(result.ok).toBe(true);
  expect(result.value.validity).toBe("valid");
  expect(result.value.references).toHaveLength(1);
});

test("computed numeric chart literals are not column tokens", () => {
  const source = `${table}@chart bar records (x: "name", y: 3)`;
  const value = snapshot(source);
  expect(value.validity).toBe("valid");
  const literal = value.tokens.find(
    (item) => item.span.start.offset === source.lastIndexOf("3"),
  );
  expect(literal.kind).toBe("literal");
});
