import { propertyRuns } from "../support/properties.mjs";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import {
  parse,
  parseRecovering,
  enrichMarkdown,
} from "../../packages/syntax/dist/index.js";
import { assertParseCase } from "../../conformance/runner/parse.mjs";
import { registry } from "../../packages/syntax/dist/registry.js";
const requireSyntax = createRequire(
  new URL("../../packages/syntax/package.json", import.meta.url),
);
const { micromark } = await import(
  pathToFileURL(requireSyntax.resolve("micromark"))
);
const { fromMarkdown } = await import(
  pathToFileURL(requireSyntax.resolve("mdast-util-from-markdown"))
);
const input = (text, profile = "tinta") => ({
  text,
  profile,
  uri: "tinta:fixture",
});
const good = (text, profile = "tinta", options) => {
  const r = parse(input(text, profile), options);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(r.ok).toBe(true);
  return r.value;
};
const bad = (text, code, options) => {
  const r = parse(input(text), options);
  expect(r.ok).toBe(false);
  expect(r.diagnostics.map((d) => d.code)).toContain(code);
  return r;
};
const flat = (n) => [n, ...n.children.flatMap(flat)];
const firstExpression = (text) =>
  flat(good(text).tree).find((n) => n.expression || n.directive?.expression)
    ?.expression ?? good(text).tree.children[0].directive.expression;

describe("official CommonMark parser corpus", () => {
  const fixtures = JSON.parse(
    readFileSync("third_party/commonmark/spec.json", "utf8"),
  );
  const provenance = JSON.parse(
    readFileSync("third_party/commonmark/provenance.json", "utf8"),
  );
  it("pins the complete official corpus and license", () => {
    expect(fixtures).toHaveLength(652);
    for (const [name, hash] of Object.entries(provenance.sha256))
      expect(
        createHash("sha256")
          .update(readFileSync("third_party/commonmark/" + name))
          .digest("hex"),
      ).toBe(hash);
  });
  const comparable = (n) => ({
    kind: n.type ?? n.kind,
    ...("value" in n ? { value: n.value } : {}),
    children: (n.children ?? []).map(comparable),
  });
  for (const f of fixtures)
    it(`${f.example}: ${f.section}`, () => {
      // Upstream unsafe HTML is an isolated test oracle, never a product rendering path.
      expect(
        micromark(f.markdown, {
          allowDangerousHtml: true,
          allowDangerousProtocol: true,
        }),
      ).toBe(f.html);
      const parsed = good(f.markdown, "markdown");
      expect(parsed.source).toBe(f.markdown);
      expect(comparable(parsed.tree)).toEqual(
        comparable(fromMarkdown(f.markdown)),
      );
      for (const node of flat(parsed.tree))
        expect(node.span.end.offset).toBeLessThanOrEqual(f.markdown.length);
    });
});

describe("lossless source and diagnostics", () => {
  it("preserves bytes, BOM, mixed line endings and astral UTF-16 spans", () => {
    const text = "\ufeff@let x = 1\r\n# 😀 {{ x }}\rLast\n";
    const bytes = new TextEncoder().encode(text);

    const r = parse({
      bytes,
      uri: "tinta:bytes",
      profile: "tinta",
    });
    expect(r.ok).toBe(true);
    expect(r.value.bytes).toEqual(bytes);
    expect(r.value.source).toBe(text);
    const n = flat(r.value.tree).find((n) => n.kind === "interpolation");
    expect(n.span.start).toEqual({
      offset: text.indexOf("{{"),
      line: 2,
      column: 6,
    });
    expect(n.expression.span.start.offset).toBe(text.indexOf("x }}"));
    expect(r.value.tree.children[0].span.start.offset).toBe(1);
    bytes[0] = 0;
    expect(r.value.bytes[0]).toBe(239);
  });
  for (const bytes of [
    [0x80],
    [0xc0, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x82],
    [0xc2, 0x20],
  ])
    it(`rejects invalid UTF-8 ${bytes}`, () => {
      const r = parse({
        bytes: Uint8Array.from(bytes),
        uri: "tinta:bad",
        profile: "tinta",
      });
      expect(r.ok).toBe(false);
      expect(r.diagnostics[0].code).toBe("E_ENCODING");
    });
  it("rejects unpaired source surrogates", () => bad("\ud800", "E_ENCODING"));
  it("warns about inert HTML and NUL while preserving source", () => {
    const p = good(
      "a\0b\n\n<script>alert(1)</script>\n\n<!-- note -->",
      "markdown",
    );
    expect(p.diagnostics.map((d) => d.code)).toEqual([
      "W_NUL_REPLACED",
      "W_HTML_INERT",
    ]);
    expect(p.source).toContain("\0");
  });
  it("retains later nodes and diagnostics after recoverable errors", () => {
    const r = parseRecovering(
      input("@unknown\n\n{{ }}\n\n# Survives\n@let valid = 1"),
    );
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "E_DIRECTIVE_UNKNOWN",
      "E_EXPRESSION_SYNTAX",
    ]);
    expect(r.value.tree.children.at(-1).directive.binding).toBe("valid");
    expect(parse(input("@unknown")).ok).toBe(false);
  });
  it("adds the original EOF as an unclosed block related span", () => {
    const r = bad("@when true\r\nhi", "E_BLOCK_UNCLOSED");
    expect(r.diagnostics[0].related[0].span.start.offset).toBe(14);
  });
  it("keeps deterministic preorder identities and parser-derived editor tokens", () => {
    const a = good("@when true\n# Text {{ 1 + 2 }}\n@end");
    const b = good(a.source);
    expect(a.tree).toEqual(b.tree);
    expect(new Set(flat(a.tree).map((n) => n.id)).size).toBe(
      flat(a.tree).length,
    );
    expect(a.tokens.some((t) => t.kind === "binary")).toBe(true);
  });
});

describe("Markdown and interpolation contexts", () => {
  for (const text of [
    "{{ x }}",
    "# {{ x }}",
    "*{{ x }}*",
    "**{{ x }}**",
    "~~{{ x }}~~",
    "> {{ x }}",
    "- {{ x }}",
    "[{{ x }}](https://x)",
    "a | b\n--|--\n{{ x }}|z",
  ])
    it(`recognizes eligible ${text}`, () =>
      expect(
        flat(good(text).tree).filter((n) => n.kind === "interpolation"),
      ).toHaveLength(1));
  for (const text of [
    "`{{ !!! }}`",
    "```\n{{ !!! }}\n```",
    "    {{ !!! }}",
    "![{{ !!! }}](x)",
    '[x](url/{{!!!}} "{{ !!! }}")',
    "<https://x/{{!!!}}>",
    "<!-- {{ !!! }} -->",
    "<div>\n{{ !!! }}\n</div>",
    "\\{{ !!! }}",
    "&#123;{ !!! }}",
  ])
    it(`leaves ineligible ${text}`, () =>
      expect(
        flat(good(text).tree).filter((n) => n.kind === "interpolation"),
      ).toHaveLength(0));
  for (const text of [
    " @let x = 1",
    "> @let x = 1",
    "- @let x = 1",
    "    @let x = 1",
    "```\n@let x = 1\n```",
    "<!--\n@let x = 1\n-->",
    "<div>\n@let x = 1\n</div>",
    "@name.example",
    "me@example.org",
    "\\@let x = 1",
  ])
    it(`does not activate ${text}`, () =>
      expect(
        flat(good(text).tree).filter((n) => n.kind === "directive"),
      ).toHaveLength(0));
  it("interrupts root paragraphs", () =>
    expect(good("Text\n@let x = 1").tree.children.map((n) => n.kind)).toEqual([
      "paragraph",
      "directive",
    ]));
  it("requires double tilde and does not enable extra dialects", () => {
    const nodes = flat(
      good(
        "~single~ ~~double~~\n\nwww.example.org\n\n[^note]\n\n---\ntitle: sample\n---",
        "markdown",
      ).tree,
    );
    expect(nodes.filter((n) => n.kind === "delete")).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === "link")).toHaveLength(0);
    expect(nodes.some((n) => n.kind === "yaml")).toBe(false);
  });
  it("parses static task-list checkboxes", () =>
    expect(
      flat(good("- [x] Complete\n- [ ] Pending", "markdown").tree)
        .filter((n) => n.kind === "listItem")
        .map((n) => n.attributes.checked),
    ).toEqual([true, false]));
  it("uses one reference map across Tinta bodies and later declarations", () => {
    const nodes = flat(
      good("@when true\n[label][ref]\n@end\n\n[ref]: https://example.org\n")
        .tree,
    );
    expect(
      nodes.find((n) => n.kind === "linkReference").attributes.destination,
    ).toBe("https://example.org");
  });
  it("resolves conventional, duplicate, full and colliding heading aliases across hidden bodies", () => {
    const nodes = flat(
      good(
        "# Hello {{ name }}\n# Hello\n# tinta-hello\n@when false\n# Hidden\n@end\n\n[a](#hello) [b](#hello-2) [c](#tinta-hello) [d](#hidden) [e](#missing) [f](#%FF)",
      ).tree,
    );
    expect(
      nodes.filter((n) => n.kind === "heading").map((n) => n.attributes.anchor),
    ).toEqual([
      "tinta-hello",
      "tinta-hello-2",
      "tinta-tinta-hello",
      "tinta-hidden",
    ]);
    expect(
      nodes
        .filter((n) => n.kind === "link")
        .map((n) => [n.attributes.resolvedDestination, n.attributes.active]),
    ).toEqual([
      ["#tinta-hello", true],
      ["#tinta-hello-2", true],
      ["#tinta-tinta-hello", true],
      ["#tinta-hidden", true],
      ["#missing", false],
      ["#%FF", false],
    ]);
  });
  for (const text of [
    "{{ }}",
    "{{ x",
    "{{ x\ny }}",
    "{{ {x} }}",
    "{{ 1; 2 }}",
    '{{ "unterminated }}',
  ])
    it(`diagnoses malformed interpolation ${text}`, () =>
      bad(text, "E_EXPRESSION_SYNTAX"));
  it("ignores closers inside JSON strings", () =>
    expect(firstExpression('{{ "}}" }}').value).toBe("}}"));
});

describe("expression grammar and bounded AST", () => {
  for (const expr of [
    "0",
    "12.5e-2",
    '"text\\nvalue"',
    "true",
    "false",
    "[]",
    "[1, 2,]",
    "row.field",
    "name",
    "(1)",
    "-+not false",
    ...registry.functions.map((n) => `${n}(1, 2)`),
    "1 + 2 * 3 < 9 == true and false or true",
  ])
    it(`parses ${expr}`, () =>
      expect(firstExpression(`{{ ${expr} }}`)).toBeDefined());
  it("honors operator precedence and left associativity", () => {
    const expr = firstExpression("{{ 8 - 4 - 2 * 3 }}");
    expect(expr.operator).toBe("-");
    expect(expr.left.operator).toBe("-");
    expect(expr.right.operator).toBe("*");
  });
  for (const expr of [
    "01",
    "1.",
    "1e",
    "1e+",
    "1_000",
    ".5",
    "x[0]",
    "row .x",
    "row. x",
    "unknown(1)",
    "min(1,)",
    "[1,,2]",
    "(1",
    "1 2",
    '"\\q"',
    '"\\ud800"',
    '"\\udc00"',
  ])
    it(`rejects ${expr}`, () => bad(`{{ ${expr} }}`, "E_EXPRESSION_SYNTAX"));
  for (const expr of ["constructor", "__proto__", "prototype", "row", "if"])
    it(`rejects reserved name ${expr}`, () =>
      bad(`{{ ${expr} }}`, "E_NAME_RESERVED"));
  it("preserves identifier token boundaries", () =>
    expect(firstExpression("{{ nottrue }}").name).toBe("nottrue"));
  it("rejects nonfinite number literals", () =>
    bad("{{ 1e999 }}", "E_NUMBER_RANGE"));
  it("accepts paired escaped surrogates", () =>
    expect(firstExpression('{{ "\\ud83d\\ude00" }}').value).toBe("😀"));
});

describe("directive and data productions", () => {
  const samples = {
    meta: "@meta ()",
    let: "@let x = 1",
    calc: "@calc x = 1",
    slider: "@slider x = -1 (min: -2)",
    toggle: "@toggle x = true",
    choice: '@choice x = "a" (options: ["a"])',
    when: "@when true\nBody\n@end",
    details: '@details "Summary"\nBody\n@end',
    data: "@data d\nx:number\n@end",
    view: "@view v = d",
    table: "@table d",
    chart: '@chart line d (x: "x", y: "y")',
  };
  for (const [name, text] of Object.entries(samples))
    it(`parses ${name}`, () =>
      expect(good(text).tree.children[0].directive.name).toBe(name));
  for (const text of [
    "@let",
    "@calc",
    "@slider x = n",
    "@toggle x = 1",
    "@choice x = true (options: [])",
    "@meta",
    "@details name\nBody\n@end",
    "@data\nx:number\n@end",
    "@view v =",
    "@table",
    "@chart line d",
    "@let x = 1 trailing",
    "@calc x =\n1",
    "@slider x = 1 (min: 0) (max: 2)",
  ])
    it(`rejects malformed ${text}`, () =>
      expect(parse(input(text)).ok).toBe(false));
  for (const type of registry.chartTypes)
    it(`parses chart ${type}`, () =>
      expect(
        good(`@chart ${type} d (x: "x")`).tree.children[0].directive.chartType,
      ).toBe(type));
  it("rejects unknown chart types", () =>
    bad('@chart map d (x: "x")', "E_CHART_TYPE"));
  it("accepts multiline open delimiters, quoted commas and trailing option commas", () => {
    const tree = good(
      '@calc x = (\n  1 + min(2,3)\n)\n@slider y = 1 (\nlabel: "One, two",\nmin: 0,\n)',
    );
    expect(tree.tree.children).toHaveLength(2);
  });
  it("retains a literal @end in fenced code inside nested blocks", () => {
    const tree = good("@when true\n@details\n```\n@end\n```\n@end\n@end");
    expect(tree.tree.children[0].children[0].children[0].value).toBe("@end");
  });
  it("rejects empty comment-only blocks", () =>
    bad("@details\n<!-- note -->\n@end", "E_BLOCK_EMPTY"));
  it("parses quote-aware text, escaped newlines, signs, booleans and original row spans", () => {
    const d = good(
      '@data d\ntext:text | n:number | b:boolean\n"A | B\\nC" | +1.2e2 | false\nraw "quote | -2 | true\n"" | 0 | false\n"@end" | 1 | true\n@end',
    ).tree.children[0].directive;
    expect(d.rows.map((r) => r.cells)).toEqual([
      ["A | B\nC", 120, false],
      ['raw "quote', -2, true],
      ["", 0, false],
      ["@end", 1, true],
    ]);
    expect(d.rows[0].span.start.line).toBe(3);
  });
  for (const [text, code] of [
    ["@data d\n@end", "E_DATA_HEADER"],
    ["@data d\nx:unknown\n@end", "E_DATA_HEADER"],
    ["@data d\nx:number|x:text\n@end", "E_DATA_HEADER"],
    ['@data d\nx:text\n"a" extra\n@end', "E_DATA_VALUE"],
    ["@data d\nx:boolean\nTRUE\n@end", "E_DATA_VALUE"],
    ["@data d\nx:number\n01\n@end", "E_DATA_VALUE"],
    ["@data d\nx:text|y:text\n|a\n@end", "E_DATA_VALUE"],
    ["@data d\nx:number\n1|2\n@end", "E_DATA_ARITY"],
    ["@data d\nx:text\n@let x = 1\n@end", "E_DATA_VALUE"],
    ["@data d\nx:number\n1", "E_BLOCK_UNCLOSED"],
  ])
    it(`rejects ${text}`, () => bad(text, code));
});

describe("token-aware enrichment", () => {
  for (const text of [
    "{{ x }}",
    "\\{{ x }}",
    "\\\\{{ x }}",
    "@unknown line",
    "@end",
    "a\n@slider x = 5",
    "`{{ x }}`\n\n```\n@foo\n```",
    "> @foo {{ x }}",
    "- {{ x }}",
    "![{{ x }}](url/{{x}})",
    "[{{ x }}](url/{{x}})",
    "<!-- {{ x }} -->\n\n<script>{{ x }}</script>",
    "\ufeff# 😀 {{ x }}\r\n@foo\r",
    "{{ *Markdown* }}",
    "[{{ x }}][r]\n\n[r]: https://example.org/{{x}}",
  ])
    it(`preserves ${text}`, () => {
      const r = enrichMarkdown(input(text, "markdown"));
      expect(r.ok).toBe(true);
      const { edits, source } = r.value;
      let applied = text;
      for (const e of edits)
        applied =
          applied.slice(0, e.start) + e.replacement + applied.slice(e.end);
      expect(applied).toBe(source);
      expect(parse(input(source)).ok).toBe(true);
      expect(r.value.originalSha256).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    });
  it("matches the exact seed enrichment fixture", () => {
    const fixture = JSON.parse(
      readFileSync("conformance/cases.json"),
    ).cases.find((c) => c.phase === "enrich");
    const r = enrichMarkdown(input(fixture.source, "markdown"));
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe(fixture.expect.exactSource);
    expect(r.value.edits).toHaveLength(fixture.expect.editCount);
  });
});

describe("registry resource ceilings", () => {
  it("uses the normative registry without drift", () =>
    expect(registry).toEqual(
      JSON.parse(readFileSync("spec/registry.json", "utf8")),
    ));
  const pairs = [
    ["sourceBytes", "abc", "abcd", 3],
    ["sourceLineUnits", "abc\ndef", "abcd", 3],
    ["expressionUnits", "{{ 1 + 2 }}", "{{ 1 + 22 }}", 5],
    ["expressionDepth", "{{ ((1)) }}", "{{ (((1))) }}", 3],
    ["identifierUnits", "{{ abc }}", "{{ abcd }}", 3],
    ["textValueUnits", '{{ "abc" }}', '{{ "abcd" }}', 3],
    ["literalListItems", "{{ [1,2] }}", "{{ [1,2,3] }}", 2],
    [
      "tintaBlockDepth",
      "@when true\nx\n@end",
      "@when true\n@details\nx\n@end\n@end",
      1,
    ],
    ["declarations", "@let x=1", "@let x=1\n@calc y=2", 1],
    ["controls", "@slider x=1", "@slider x=1\n@toggle y=true", 1],
    ["tableCount", "@view x=d", "@view x=d\n@view y=d", 1],
    [
      "chartCount",
      '@chart line d (x:"x")',
      '@chart line d (x:"x")\n@chart line d (x:"x")',
      1,
    ],
    [
      "tableRows",
      "@data d\nx:number\n1\n@end",
      "@data d\nx:number\n1\n2\n@end",
      1,
    ],
    [
      "tableColumns",
      "@data d\nx:number\n@end",
      "@data d\nx:number|y:number\n@end",
      1,
    ],
    [
      "totalCells",
      "@data d\nx:number\n1\n@end",
      "@data d\nx:number\n1\n2\n@end",
      1,
    ],
    ["markdownDepth", "a", "*a*", 2],
    ["astNodes", "a", "a\n\nb", 3],
  ];
  for (const [name, at, over, max] of pairs)
    it(`enforces ${name}`, () => {
      good(at, "tinta", { limits: { [name]: max } });
      const r = bad(over, "E_LIMIT", { limits: { [name]: max } });
      expect(r.diagnostics[0].details.limitName).toBe(name);
    });
  it("rejects a 129-unit number token and accepts 128", () => {
    good("{{ 0." + "0".repeat(125) + "1 }}");
    bad("{{ 0." + "0".repeat(126) + "1 }}", "E_LIMIT");
  });
  it("rejects weakening, unknown and invalid limits", () => {
    for (const limits of [
      { sourceBytes: registry.limits.sourceBytes + 1 },
      { unknown: 1 },
      { astNodes: 0 },
      { controls: 1.5 },
    ])
      bad("a", "E_LIMIT", { limits });
  });
  it("enforces operation and diagnostic budgets", () => {
    bad("@let a=1", "E_LIMIT", { limits: { compileOperations: 1 } });
    bad("<x>\n\n<y>", "E_LIMIT", { limits: { diagnostics: 1 } });
  });
});

describe("deterministic adversarial properties", () => {
  it("never executes or throws on bounded malformed text", () =>
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const r = parse(input(text));
        expect(typeof r.ok).toBe("boolean");
      }),
      { seed: 184731, numRuns: propertyRuns },
    ));
  it("preserves unedited Markdown bytes through explicit enrichment", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "text",
            "{{ value }}",
            "`{{ code }}`",
            "**bold**",
            "\\{{ escaped }}",
            "😀",
            "[link](https://example.org)",
          ),
          { maxLength: 15 },
        ),
        (parts) => {
          const text = parts.join(" ");
          const r = enrichMarkdown(input(text, "markdown"));
          expect(r.ok).toBe(true);
          expect(r.value.source.replace(/(?<!\\)\\(?=\{\{ value)/g, "")).toBe(
            text,
          );
        },
      ),
      { seed: 184732, numRuns: propertyRuns },
    ));
});

describe("public syntax conformance adapter", () => {
  const fixtures = JSON.parse(readFileSync("conformance/cases.json")).cases;
  for (const fixture of fixtures.filter(
    (c) => !["csv", "json"].includes(c.phase),
  ))
    it(fixture.id + " parse assertions only", () => {
      const result = assertParseCase(fixture);
      expect(result.parse ?? result.enrich).toBe("PASS");
      expect(result.semantic).toBe(
        fixture.phase === "enrich" ? "NOT_APPLICABLE" : "NOT_RUN",
      );
    });
});

describe("adversarial parsing and recovery boundaries", () => {
  it("enforces the shared budget during ordinary Markdown tokenization", () => {
    const r = parse(input("ordinary ".repeat(100), "markdown"), {
      limits: { compileOperations: 100 },
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].details).toEqual({
      limitName: "compileOperations",
      observed: 101,
      maximum: 100,
    });
  });
  it("rejects deeply nested containers before recursive tree construction", () =>
    bad("> ".repeat(1000) + "text", "E_LIMIT"));
  it("recognizes directive options without merging adjacent tokens", () => {
    bad('@chart line-data (x: "x")', "E_DIRECTIVE_SYNTAX");
    bad("@slider x = (1)", "E_DIRECTIVE_SYNTAX");
    bad("@slider x = - 1", "E_DIRECTIVE_SYNTAX");
    bad("@table(d)", "E_DIRECTIVE_SYNTAX");
    bad('@let x = 1 (label: "a")', "E_DIRECTIVE_SYNTAX");
    bad("@when true\n@end extra", "E_BLOCK_END");
    bad('@chart line d (x "x")', "E_DIRECTIVE_SYNTAX");
  });
  it("requires boundaries around word operators and calls", () => {
    bad("{{ 1and true }}", "E_EXPRESSION_SYNTAX");
    bad("@let x = (min\n(1,2))", "E_EXPRESSION_SYNTAX");
  });
  it("retains non-directive @ text in typed cells", () => {
    const data = good("@data d\nx:text | y:text\n@name.example | @person\n@end")
      .tree.children[0].directive;
    expect(data.rows[0].cells).toEqual(["@name.example", "@person"]);
  });
  it("accepts strict UTF-8 across all scalar widths and chunk boundaries", () => {
    const text = "ä€😀".repeat(1100);

    const r = parse({
      bytes: new TextEncoder().encode(text),
      uri: "tinta:unicode",
      profile: "markdown",
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe(text);
  });
  it("fails closed when enrichment cannot preserve an ineligible code span", () => {
    const r = enrichMarkdown(input("`text\n@let x = 1\nend`", "markdown"));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe("E_IMPORT_PRESERVATION");
  });
  it("rejects invalid encoding before enrichment", () => {
    const r = enrichMarkdown({
      bytes: Uint8Array.of(255),
      uri: "tinta:bad",
      profile: "markdown",
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe("E_ENCODING");
  });
  it("does not enrich CommonMark autolinks", () =>
    expect(
      enrichMarkdown(input("<https://example.org/{{x}}>", "markdown")).value
        .edits,
    ).toEqual([]));
  it("maps accents, empty and percent-encoded heading links", () => {
    const nodes = flat(
      good(
        "# Héllo\n# !!!\n\n[a](#h%C3%A9llo) [b](#hello) [c](#tinta-section) [d](relative.md) [e](//host) [f](mailto:a@b)",
      ).tree,
    );
    expect(
      nodes.filter((n) => n.kind === "heading").map((n) => n.attributes.anchor),
    ).toEqual(["tinta-hello", "tinta-section"]);
    expect(
      nodes.filter((n) => n.kind === "link").map((n) => n.attributes.active),
    ).toEqual([false, true, true, false, false, true]);
  });
});

describe("normative default-limit edges", () => {
  it("checks the full source byte ceiling before parsing", () => {
    const bytes = new Uint8Array(registry.limits.sourceBytes + 1);

    const r = parse({
      bytes,
      profile: "markdown",
      uri: "tinta:large",
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].details.limitName).toBe("sourceBytes");
  });
  it("checks maximum line length and text-cell length together", () => {
    const text = "x".repeat(registry.limits.textValueUnits);
    good("@data d\nx:text\n" + text + "\n@end");
    bad("@data d\nx:text\n" + text + "x\n@end", "E_LIMIT");
  });
  it("checks the identifier ceiling", () => {
    good("@let " + "x".repeat(64) + "=1");
    bad("@let " + "x".repeat(65) + "=1", "E_LIMIT");
  });
  it("checks expression text, depth and list item ceilings", () => {
    good('{{ "' + "x".repeat(8190) + '" }}');
    bad('{{ "' + "x".repeat(8191) + '" }}', "E_LIMIT");
    good("{{ " + "(".repeat(31) + "1" + ")".repeat(31) + " }}");
    bad("{{ " + "(".repeat(32) + "1" + ")".repeat(32) + " }}", "E_LIMIT");
    good("{{ [" + Array(1000).fill("1").join(",") + "] }}");
    bad("{{ [" + Array(1001).fill("1").join(",") + "] }}", "E_LIMIT");
  });
  it("checks declaration/control/table/chart ceilings", () => {
    for (const [count, make] of [
      [512, (i) => `@let x${i}=1`],
      [128, (i) => `@toggle x${i}=true`],
      [64, (i) => `@view x${i}=d`],
      [32, () => '@chart line d (x:"x")'],
    ]) {
      good(Array.from({ length: count }, (_, i) => make(i)).join("\n"));
      bad(
        Array.from({ length: count + 1 }, (_, i) => make(i)).join("\n"),
        "E_LIMIT",
      );
    }
  });
  it("checks data row, column and cell ceilings", () => {
    good("@data d\nx:number\n" + "1\n".repeat(10000) + "@end");
    bad("@data d\nx:number\n" + "1\n".repeat(10001) + "@end", "E_LIMIT");
    const header = (n) =>
      Array.from({ length: n }, (_, i) => `x${i}:number`).join("|");
    good("@data d\n" + header(64) + "\n@end");
    bad("@data d\n" + header(65) + "\n@end", "E_LIMIT");
    const cells = "1|".repeat(9) + "1\n";
    const block =
      "@data d\n" + header(10) + "\n" + cells.repeat(10000) + "@end";
    good(block);
    bad(block + "\n@data extra\nx:number\n1\n@end", "E_LIMIT");
  });
  it("checks block and Markdown depths", () => {
    good("@when true\n".repeat(16) + "x\n" + "@end\n".repeat(16));
    bad("@when true\n".repeat(17) + "x\n" + "@end\n".repeat(17), "E_LIMIT");
    good("> ".repeat(62) + "x");
    bad("> ".repeat(63) + "x", "E_LIMIT");
  });
  it("enforces diagnostic ceiling without silently truncating", () => {
    good(Array(100).fill("<x>\n").join("\n"));
    bad(Array(101).fill("<x>\n").join("\n"), "E_LIMIT");
  });
  it("rejects scheme whitespace after entity decoding", () => {
    const r = good("[x](<https:&#9;//example.org>)");
    expect(r.diagnostics[0].code).toBe("W_LINK_UNSAFE");
    expect(flat(r.tree).find((n) => n.kind === "link").attributes.active).toBe(
      false,
    );
  });
  it("keeps all heading IDs unique when literal suffixes collide", () => {
    expect(
      flat(good("# a\n# a\n# a-2").tree)
        .filter((n) => n.kind === "heading")
        .map((n) => n.attributes.anchor),
    ).toEqual(["tinta-a", "tinta-a-2", "tinta-a-2-2"]);
  });
});

describe("complete grammar production matrix", () => {
  const cases = JSON.parse(readFileSync("tests/fixtures/grammar.json", "utf8"));
  it("covers every named EBNF production", () => {
    const names = [
      ...readFileSync("spec/grammar.ebnf", "utf8").matchAll(
        /^([a-z][a-z0-9-]*)\s*=/gm,
      ),
    ].map((m) => m[1]);
    expect(cases.map((c) => c.production)).toEqual(names);
  });
  for (const c of cases)
    it(c.production + " positive, malformed and boundary", () => {
      good(c.positive);
      good(c.boundary);
      if (c.malformedIsLiteral)
        expect(
          flat(good(c.malformed).tree).find((n) => n.kind === "text").value,
        ).toBe(c.malformed);
      else expect(parse(input(c.malformed)).ok).toBe(false);
    });
});

it("column-one blocks terminate a potential lazy continuation", () => {
  for (const prefix of ["- item", "> text"]) {
    expect(
      good(prefix + "\n@let x=1").tree.children.at(-1).directive.name,
    ).toBe("let");
    const r = enrichMarkdown(input(prefix + "\n@let x=1", "markdown"));
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe(prefix + "\n\\@let x=1");
  }
});

describe("generated expression and container properties", () => {
  const leaf = fc.oneof(
    fc.integer({ min: -1000, max: 1000 }).map(String),
    fc.boolean().map(String),
    fc.string({ maxLength: 20 }).map(JSON.stringify),
  );
  const expr = fc
    .tuple(
      leaf,
      fc.constantFrom(
        "+",
        "-",
        "*",
        "/",
        "%",
        "==",
        "!=",
        "<",
        "<=",
        ">",
        ">=",
        "and",
        "or",
      ),
      leaf,
    )
    .map(([a, op, b]) => `(${a} ${op} ${b})`);
  it("accepts generated bounded grammar without evaluating it", () =>
    fc.assert(
      fc.property(
        fc.oneof(
          leaf,
          expr,
          fc.tuple(expr, expr).map(([a, b]) => `if(true,${a},${b})`),
        ),
        (source) => {
          expect(parse(input(`{{ ${source} }}`)).ok).toBe(true);
        },
      ),
      { seed: 184733, numRuns: propertyRuns },
    ));
  it("recovers from malformed expression/directive streams without throwing", () =>
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (source) => {
        const r = parseRecovering(
          input(`@calc value = ${source}\n\n# Later\n`),
        );
        expect(typeof r.ok).toBe("boolean");
      }),
      { seed: 184734, numRuns: propertyRuns },
    ));
});

it("keeps all image-alt Markdown inert even with incomplete templates", () => {
  for (const text of [
    "![{{](x)",
    "![{{ **bold** }}](x)",
    '![{{ " ] " }}](x)',
    "![{{][ref]\n\n[ref]: asset.png",
  ]) {
    const original = good(text, "markdown");
    const parsed = good(text);
    const originalImages = flat(original.tree).filter(
      (n) => n.kind === "image" || n.kind === "imageReference",
    );
    expect(
      flat(parsed.tree).filter((n) => n.kind === "interpolation"),
    ).toHaveLength(originalImages.length ? 0 : 1);
    expect(
      flat(parsed.tree)
        .filter((n) => n.kind === "image" || n.kind === "imageReference")
        .map((n) => n.attributes),
    ).toEqual(
      flat(original.tree)
        .filter((n) => n.kind === "image" || n.kind === "imageReference")
        .map((n) => n.attributes),
    );
    expect(enrichMarkdown(input(text, "markdown")).ok).toBe(true);
  }
  expect(
    flat(good("![unclosed {{ 1 }}").tree).filter(
      (n) => n.kind === "interpolation",
    ),
  ).toHaveLength(1);
});
