import { describe, expect, it } from "vitest";
import {
  analyze,
  completion,
  signatureHelp,
  functionExample,
  catalog,
} from "../../packages/language-service/dist/index.js";
import { authoring } from "../../packages/language-server/dist/authoring.js";
import { compile, createSession } from "../../packages/engine/dist/index.js";

const table =
  "@data records\nname:text | value:number | ready:boolean\nA | 2 | true\n@end\n";
function snapshot(text, profile = "tinta") {
  const result = analyze(
    { uri: "untitled:authoring", profile, text },
    {
      documentInstance: "a".repeat(32),
      editorVersion: 1,
      sourceRevision: 1,
    },
  );
  expect(result.ok).toBe(true);
  return result.value;
}
function marked(source, kind = "completion") {
  const offset = source.indexOf("¦");
  const text = source.replace("¦", "");
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  const point = { line: lines.length - 1, character: lines.at(-1).length };
  return {
    text,
    offset,
    snapshot: snapshot(text),
    query: { kind, position: point },
  };
}
function items(source) {
  const value = marked(source);
  return authoring(value.snapshot, value.query);
}
function labels(source) {
  return items(source).map((item) => item.label);
}
function insert(text, edit) {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") starts.push(i + 1);
  const start = starts[edit.range.start.line] + edit.range.start.character;
  const end = starts[edit.range.end.line] + edit.range.end.character;
  return text.slice(0, start) + edit.newText + text.slice(end);
}
function valid(text) {
  const result = compile({ uri: "untitled:inserted", profile: "tinta", text });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  const session = createSession(result.value);
  expect(session.ok, JSON.stringify(session.diagnostics)).toBe(true);
  session.value.destroy();
}

describe("contextual native authoring", () => {
  it("restricts root declarations, metadata, end and literal regions", () => {
    expect(labels("@¦")).toContain("meta example");
    for (const name of ["chart", "table", "view"])
      expect(labels("@¦")).toContain(`${name} example`);
    expect(labels("@¦")).not.toContain("end");
    expect(labels("<!-- note -->\n@¦")).toContain("meta");
    for (const source of [
      "# Heading\n@¦",
      "[ref]: https://example.test\n\n@¦",
      '@meta (title: "Title")\n@¦',
    ])
      expect(labels(source)).not.toContain("meta");
    const nested = labels('@details "Details"\n@¦\n@end');
    expect(nested).toContain("end");
    expect(nested).toContain("slider example");
    for (const name of ["meta", "let", "calc", "data", "view"])
      expect(nested).not.toContain(name);
    for (const source of [
      "```tinta\n@¦\n```",
      "    @¦",
      "> @¦",
      "- @¦",
      "<!-- @¦ -->",
      "Text @¦",
      "`{{ m¦ }}`",
      "![{{ m¦ }}](x.png)",
    ])
      expect(items(source)).toEqual([]);
  });

  it("offers unused options and respects literal-only and selection positions", () => {
    const options = labels('@slider amount = 1 (label: "Amount", ¦)');
    expect(options).toContain("step");
    expect(options).not.toContain("label");
    expect(labels("@slider amount = 1 (step: ¦)")).toEqual(["1"]);
    expect(labels("@slider amount = 1 (label: ¦)")).toEqual(['"Text"']);
    expect(labels("@toggle enabled = ¦")).toEqual(["true", "false"]);
    expect(labels("@meta (locale: ¦)")).toContain('"en-US"');
    expect(labels(table + "@chart histogram records (¦)")).not.toContain("y");
    expect(labels(table + "@chart bar records (¦)")).not.toContain("bins");
    const controls =
      '@slider amount = 1\n@choice pick = "A" (options: ["A"])\n@toggle enabled = true\n';
    expect(
      labels(
        controls +
          table +
          '@chart bar records (x: "name", y: "value", select: ¦)',
      ),
    ).toEqual(["pick"]);
    const replaced = items('@slider amount = 1 (la¦bel: "Amount")').find(
      (item) => item.label === "label",
    );
    expect(replaced.textEdit.newText).toBe("label");
    expect(
      items("@slider amount = 1 (¦)").find((item) => item.label === "label")
        .textEdit.newText,
    ).toBe("label: ");
  });

  it("completes globals, table sources, row columns and numeric aggregate columns", () => {
    const prefix = "@let constant = 1\n@calc derived = 2\n" + table;
    expect(labels(prefix + "@let next = ¦")).toContain("constant");
    expect(labels(prefix + "@let next = ¦")).not.toContain("derived");
    expect(labels(prefix + "@let next = ¦")).not.toContain("sum");
    expect(labels(prefix + "@table ¦")).toEqual(["records"]);
    expect(labels(prefix + "@view filtered = records (where: row.¦)")).toEqual([
      "name",
      "value",
      "ready",
    ]);
    expect(labels(prefix + '@chart bar records (x: "name", y: row.¦)')).toEqual(
      ["name", "value", "ready"],
    );
    expect(labels(prefix + "@calc total = sum(records, ¦)")).toEqual([
      '"value"',
    ]);
    expect(labels(prefix + '{{ mean(records, "va¦") }}')).toEqual(['"value"']);
    expect(labels(prefix + '@chart bar records (x: "name", y: ¦)')).toContain(
      '"value"',
    );
    expect(labels(prefix + "@view filtered = records (sort: ¦)")).toEqual([
      '"name"',
      '"value"',
      '"ready"',
    ]);
    expect(labels("@let constructor = 1\n{{ ¦ }}")).not.toContain(
      "constructor",
    );
    expect(labels("@let same = 1\n@let same = 2\n{{ ¦ }}")).not.toContain(
      "same",
    );
    expect(
      labels(
        table + "@calc broken = )\n@view filtered = records (where: row.¦)",
      ),
    ).toContain("value");
    expect(labels("{{ row.¦ }}")).not.toContain("value");
  });

  it("inserts complete examples that compile, avoids collisions and illegal metadata", () => {
    for (const source of [
      "@¦",
      table + "@¦",
      "@let example = 1\n@let example2 = 2\n@¦",
      '@details "Details"\n@¦\n@end',
    ]) {
      const { text } = marked(source);
      const examples = items(source).filter((item) => item.kind === 15);
      expect(examples.length).toBeGreaterThan(0);
      for (const item of examples) valid(insert(text, item.textEdit));
    }
    expect(items("@sl¦ider old = 1").every((item) => item.kind !== 15)).toBe(
      true,
    );
    const value = marked(table + "@calc total = sum(records, ¦)");
    for (const item of authoring(value.snapshot, value.query))
      valid(insert(value.text, item.textEdit));
    const literal = marked("@toggle enabled = ¦");
    for (const item of authoring(literal.snapshot, literal.query))
      valid(insert(literal.text, item.textEdit));
  });

  it("shows safe plain-text help, types and nested incomplete signatures", () => {
    const value = marked("@let amount = 1\n{{ am¦ount }}", "hover");
    expect(authoring(value.snapshot, value.query).contents).toEqual({
      kind: "plaintext",
      value: "amount: number",
    });
    const cases = [
      ["{{ pow(2, round(1.2, ¦)) }}", "round(number, number=0) -> number", 1],
      ["{{ if(true, min(1, 2), ¦) }}", "if(boolean, T, T) -> T", 2],
      ["{{ count([1, 2, ¦]) }}", "count(list<T> or table<S>) -> number", 0],
      ["{{ fixed(1, ¦", "fixed(number, number) -> text", 1],
      ["{{ money(¦) }}", "money(number) -> text", 0],
      ['{{ sum(records, "va¦") }}', 'sum(table<S>, "column") -> number', 1],
    ];
    for (const [source, label, argument] of cases) {
      const current = marked(source, "signature");
      const result = authoring(current.snapshot, current.query);
      expect(result.signatures[0].label).toBe(label);
      expect(result.activeParameter).toBe(argument);
      expect(result.signatures[0].documentation.kind).toBe("plaintext");
    }
    for (const source of [
      "`{{ pow(¦`",
      '{{ "pow(¦" }}',
      '@slider amount = 1 (label: "pow(¦")',
      "{{ pow(1, 2) ¦}}",
    ]) {
      const current = marked(source, "signature");
      expect(authoring(current.snapshot, current.query)).toBeNull();
    }
    const partial = marked("@calc broken = )\n@sl¦ider amount = 1", "hover");
    expect(authoring(partial.snapshot, partial.query).contents.value).toContain(
      "Numeric control",
    );
  });

  it("selects exact globals, ignores prose/strings/fences/columns and ambiguous bindings", () => {
    const text =
      '@let amount = 1\n# 😀 Amount\namount `amount` "amount"\n```tinta\n{{ amount }}\n```\n' +
      table +
      "{{ ((amount)) }}\n@calc total = amount + 2\n";
    const state = snapshot(text);
    const referenceOffset = text.indexOf("((amount))") + 2;
    const source =
      text.slice(0, referenceOffset + 2) +
      "¦" +
      text.slice(referenceOffset + 2);
    const value = marked(source, "definition");
    expect(authoring(state, value.query)).toEqual([
      {
        uri: "untitled:authoring",
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 11 },
        },
      },
    ]);
    expect(
      authoring(state, {
        ...value.query,
        kind: "references",
        includeDeclaration: true,
      }),
    ).toHaveLength(3);
    expect(
      authoring(state, {
        kind: "references",
        position: { line: 0, character: 6 },
      }),
    ).toHaveLength(2);
    for (const point of [
      { line: 2, character: 2 },
      { line: 4, character: 5 },
      { line: 7, character: 2 },
    ])
      expect(authoring(state, { kind: "definition", position: point })).toEqual(
        [],
      );
    const duplicate = marked(
      "@let amount = 1\n@let amount = 2\n{{ am¦ount }}",
      "definition",
    );
    expect(authoring(duplicate.snapshot, duplicate.query)).toEqual([]);
    expect(
      authoring(duplicate.snapshot, {
        ...duplicate.query,
        kind: "references",
        includeDeclaration: true,
      }),
    ).toEqual([]);
    const symbols = authoring(state, { kind: "symbols" });
    expect(symbols.map((item) => item.name)).toEqual([
      "amount",
      "😀 Amount",
      "records",
      "total",
    ]);
    expect(symbols[0].selectionRange).toEqual({
      start: { line: 0, character: 5 },
      end: { line: 0, character: 11 },
    });
  });

  it("rejects invalid positions and leaves Markdown inactive", () => {
    for (const position of [
      undefined,
      { line: -1, character: 0 },
      { line: 100, character: 0 },
      { line: 0, character: -1 },
      { line: 0, character: 99 },
      { line: 0.5, character: 0 },
    ])
      expect(
        authoring(snapshot("@let n = 1\r\n"), { kind: "completion", position }),
      ).toBeNull();
    const state = snapshot("# Title\n{{ pow(1, 2) }}", "markdown");
    expect(completion(state, 12).allowedNames).toEqual([]);
    expect(signatureHelp(state, 12)).toBeUndefined();
    expect(
      authoring(state, { kind: "hover", position: { line: 0, character: 0 } }),
    ).toBeNull();
  });
});

it("inserts complete built-in calls without duplicating existing parentheses or literals", () => {
  for (const source of ["@calc result = ¦", table + "@calc result = ¦"]) {
    const current = marked(source);
    const functions = authoring(current.snapshot, current.query).filter(
      (item) => item.kind === 3,
    );
    expect(functions.length).toBeGreaterThanOrEqual(9);
    for (const item of functions) valid(insert(current.text, item.textEdit));
  }
  expect(
    items("{{ mi¦n(1, 2) }}").find((item) => item.label === "min").textEdit
      .newText,
  ).toBe("min");
  for (const source of [
    "@toggle enabled = ¦true",
    '@slider amount = 1 (label: ¦"Name")',
    "@slider amount = 1 (step: ¦1)",
  ]) {
    const current = marked(source);
    for (const item of authoring(current.snapshot, current.query))
      valid(insert(current.text, item.textEdit));
  }
});

it("keeps literal list items flat and restricts chart column literals", () => {
  const choice = marked('@choice pick = "Text" (options: [¦])');
  const proposals = authoring(choice.snapshot, choice.query);
  expect(proposals.map((item) => item.label)).toEqual(['"Text"']);
  for (const item of proposals) valid(insert(choice.text, item.textEdit));
  expect(labels(table + "@chart bar records (x: ¦)")).toEqual([
    '"name"',
    '"value"',
  ]);
  expect(labels(table + '@chart bar records (x: "name", y: [¦])')).toEqual([
    '"value"',
  ]);
  expect(labels(table + '@chart bar records (x: "name", y: "va¦")')).toEqual([
    '"value"',
  ]);
});

it("keeps help catalog coverage aligned and refuses unknown call examples", () => {
  const options = [...new Set(Object.values(catalog.options).flat())].sort();
  expect(Object.keys(catalog.optionDescriptions).sort()).toEqual(options);
  expect(Object.keys(catalog.examples)).toEqual(catalog.functions);
  expect(functionExample(snapshot(""), "constructor")).toBeUndefined();
  expect(
    functionExample(snapshot("@data labels\nname:text\nA\n@end"), "sum"),
  ).toBeUndefined();
  const controls = '@slider amount = 1\n@choice pick = "A" (options: ["A"])\n';
  expect(
    labels(
      controls +
        table +
        '@chart bar records (x: "value", y: "value", select: ¦)',
    ),
  ).toEqual(["amount"]);
  expect(
    labels(
      controls +
        table +
        '@chart bar records (x: "ready", y: "value", select: ¦)',
    ),
  ).toEqual([]);
  expect(
    labels(
      controls + table + '@chart histogram records (x: "value", select: ¦)',
    ),
  ).toEqual([]);
  const source = marked(
    "@let count_value = 1\r\n😀 {{ count_¦value }}",
    "definition",
  );
  expect(authoring(source.snapshot, source.query)[0].range).toEqual({
    start: { line: 0, character: 5 },
    end: { line: 0, character: 16 },
  });
});

it("handles future option keys and parenthesized computed chart expressions", () => {
  expect(labels('@slider amount = 1 (¦, label: "Amount")')).not.toContain(
    "label",
  );
  expect(labels('@slider amount = 1 (la¦bel: "Amount")')).toContain("label");
  expect(
    labels(table + '@chart bar records (x: "name", y: round(row.¦))'),
  ).toEqual(["name", "value", "ready"]);
  const call = marked(
    table + '@chart bar records (x: "name", y: round(row.value, ¦))',
    "signature",
  );
  expect(authoring(call.snapshot, call.query).signatures[0].label).toBe(
    "round(number, number=0) -> number",
  );
  const controls = '@slider amount = 1\n@choice pick = "A" (options: ["A"])\n';
  expect(
    labels(
      controls +
        table +
        '@chart bar records (select: ¦, x: "name", y: "value")',
    ),
  ).toEqual(["pick"]);
});
