import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import Ajv2020 from "ajv/dist/2020.js";
import {
  compile,
  createSession,
  encodeProgram,
  decodeProgram,
  importCsv,
  importJson,
} from "../../packages/engine/dist/index.js";
import { assertSemanticCase } from "../../conformance/runner/semantic.mjs";

const input = (text) => ({ text, uri: "tinta:test", profile: "tinta" });

function program(text, options) {
  const result = compile(input(text), options);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.value;
}

function session(text, options) {
  const result = createSession(program(text), options);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.value;
}

function error(result, code) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  expect(result).not.toHaveProperty("value");
}

const fixtures = JSON.parse(
  readFileSync("conformance/cases.json", "utf8"),
).cases;
describe("public semantic conformance", () => {
  for (const fixture of fixtures)
    it(fixture.id, () => assertSemanticCase(fixture));
});
describe("typed expressions", () => {
  const results = [
    ["1 + 2 * 3", 7],
    ["-5 % 3", -2],
    ["+2", 2],
    ["not false", true],
    ["true and false", false],
    ["false or true", true],
    ["true or (1 / 0 == 0)", true],
    ["1 < 2", true],
    ["2 <= 2", true],
    ["3 > 2", true],
    ["2 >= 2", true],
    ['"a" != "b"', true],
    ["round(-0.5)", 0],
    ["round(1.235, 2)", 1.24],
    ["pow(0, 0)", 1],
    ["count([])", 0],
    ["if(false, [], [1,2])", [1, 2]],
    ["if(true, [], [1])", []],
    ["if(false, [1], [])", []],
    ['if(true, "yes", "no")', "yes"],
    ["if(false, 1, 2)", 2],
    ["min(3, 2)", 2],
    ["max(3, 2)", 3],
    ["round(1.1)", 1],
    ["fixed(1, 0)", "1"],
    ["percent(0.125)", "12.5%"],
    ["money(2)", "$2.00"],
  ];
  for (const [expr, expected] of results)
    it(expr, () =>
      expect(
        session(`@calc result = ${expr}\n`).getRevision().values.result,
      ).toEqual(expected),
    );
  const invalid = [
    ["[[1]]", "E_TYPE"],
    ['[1,"x"]', "E_TYPE"],
    ["[true,1]", "E_TYPE"],
    ["not 1", "E_TYPE"],
    ['-"a"', "E_TYPE"],
    ["true + false", "E_TYPE"],
    ['"a" < "b"', "E_TYPE"],
    ["1 == true", "E_TYPE"],
    ["[] == []", "E_TYPE"],
    ["1 and 2", "E_TYPE"],
    ["if(1, 2, 3)", "E_TYPE"],
    ["if(true, 1, false)", "E_TYPE"],
    ["count(1)", "E_TYPE"],
    ["min(1)", "E_FUNCTION_ARITY"],
    ["money(1,2)", "E_FUNCTION_ARITY"],
    ["if(true, 1)", "E_FUNCTION_ARITY"],
    ["round(1,2,3)", "E_FUNCTION_ARITY"],
    ['pow("x",2)', "E_TYPE"],
    ["row.x", "E_ROW_SCOPE"],
  ];
  for (const [expr, code] of invalid)
    it(`rejects ${expr}`, () =>
      error(compile(input(`@calc result = ${expr}\n`)), code));
  for (const [expr, code] of [
    ["1/0", "E_DIV_ZERO"],
    ["1%0", "E_DIV_ZERO"],
    ["1e308*10", "E_NUMBER_RANGE"],
    ["pow(-1,0.5)", "E_NUMBER_RANGE"],
    ["pow(10,400)", "E_NUMBER_RANGE"],
    ["round(1e308,10)", "E_NUMBER_RANGE"],
    ["round(1,-1)", "E_DIGITS_RANGE"],
    ["fixed(1,1.5)", "E_DIGITS_RANGE"],
    ["fixed(1,11)", "E_DIGITS_RANGE"],
  ])
    it(`rejects runtime ${expr}`, () =>
      error(createSession(program(`@calc result = ${expr}\n`)), code));
  it("formats extremes and explicit locale/currency", () => {
    const s = session(
      '@meta (locale: "ja-JP", currency: "JPY")\n{{ money(1234) }} {{ 1e21 }} {{ 1e-11 }} {{ true }}\n',
    );
    const children = s.getRevision().nodes[0].children;
    expect(
      children
        .filter((n) => n.kind === "text")
        .map((n) => n.value)
        .join(""),
    ).toBe("￥1,234 1e+21 1e-11 true");
  });
  it("checks aggregate columns statically even in lazy branches", () => {
    const data = "@data d\nx:text\n@end\n";
    for (const expr of [
      'sum(d,"x")',
      'sum(d,if(true,"x","x"))',
      'if(true,1,sum(d,"x"))',
      'sum(1,"x")',
      "if(true,d,d)",
    ])
      error(compile(input(data + `@calc result = ${expr}\n`)), "E_TYPE");
    error(compile(input(data + "@calc result = d\n")), "E_TYPE");
  });
  it("preserves the smallest failing expression span", () => {
    const source = "@calc result = 1 / 0\n";
    const result = createSession(program(source));
    expect(
      source.slice(
        result.diagnostics[0].span.start.offset,
        result.diagnostics[0].span.end.offset,
      ),
    ).toBe("1 / 0");
  });
});
describe("transactions", () => {
  const source =
    '@slider n = 1 (min: 0, max: 3)\n@toggle enabled = true\n@choice color = "red" (options: ["red","blue"])\n@calc inverse = 1/n\n';
  it("validates the whole patch before a single atomic commit", () => {
    const s = session(source),
      seen = [];
    s.subscribe((r) => seen.push(r));
    const before = s.getRevision();
    error(s.setControls({ enabled: false, color: "green" }), "E_STATE_DOMAIN");
    error(s.setControls({ enabled: false, n: 0 }), "E_DIV_ZERO");
    expect(s.getRevision()).toBe(before);
    expect(seen).toEqual([]);
    expect(s.setControls({ n: 2, enabled: false, color: "blue" }).ok).toBe(
      true,
    );
    expect(seen).toEqual([s.getRevision()]);
    expect(s.getRevision().number).toBe(1);
    expect(s.getRevision().values.inverse).toBe(0.5);
    expect(Object.isFrozen(s.getRevision().state)).toBe(true);
    expect(() => {
      s.getRevision().values.inverse = 9;
    }).toThrow();
  });
  it("no-op, baseline, reset, disposal and observer ordering", () => {
    const s = session(source, {
      baseline: { n: 2, enabled: false, color: "blue" },
    });
    const seen = [];
    const off = s.subscribe((r) => seen.push(`a${r.number}`));
    s.subscribe((r) => seen.push(`b${r.number}`));
    expect(seen).toEqual([]);
    expect(s.setControls({}).value.number).toBe(0);
    expect(s.reset().value.number).toBe(0);
    s.setControl("n", 3);
    off();
    off();
    expect(s.reset().value.state).toEqual({
      n: 2,
      enabled: false,
      color: "blue",
    });
    expect(seen).toEqual(["a1", "b1", "b2"]);
    const last = s.getRevision();
    s.destroy();
    s.destroy();
    error(s.setControl("n", 2), "E_PROTOCOL");
    error(s.reset(), "E_PROTOCOL");
    s.subscribe(() => {
      throw new Error("must not run");
    })();
    expect(s.getRevision()).toBe(last);
  });
  it("rejects reentrancy and reports listener failures after commit", () => {
    const s = session(source),
      calls = [];
    s.subscribe((r) => {
      calls.push(r.number);
      error(s.setControl("n", 3), "E_PROTOCOL");
      error(s.reset(), "E_PROTOCOL");
      throw new Error("host");
    });
    s.subscribe((r) => calls.push(r.values.inverse));
    const result = s.setControl("n", 2);
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0].code).toBe("E_INTERNAL");
    expect(calls).toEqual([1, 0.5]);
    expect(s.getRevision().number).toBe(1);
  });
  it("destroy during notification prevents further callbacks", () => {
    const s = session(source);
    let count = 0;
    s.subscribe(() => s.destroy());
    s.subscribe(() => count++);
    expect(s.setControl("n", 2).ok).toBe(true);
    expect(count).toBe(0);
  });
  it("requires complete valid baselines and rejects forged brands", () => {
    const p = program(source);
    for (const baseline of [
      {},
      { n: 2 },
      { n: 0, enabled: true, color: "red" },
      {
        n: 1,
        enabled: true,
        color: "red",
        other: 1,
      },
    ])
      expect(createSession(p, { baseline }).ok).toBe(false);
    error(createSession({ ...p }), "E_PROTOCOL");
    expect(() => encodeProgram({ ...p })).toThrow();
  });
  it("normalizes negative zero without a revision", () => {
    const s = session("@slider n = -0 (min: -1, max: 1)\n");
    expect(Object.is(s.getRevision().state.n, -0)).toBe(false);
    expect(s.setControl("n", -0).value.number).toBe(0);
  });
  it("guards visible outputs while retaining global hidden controls", () => {
    const s = session(
      "@toggle visible = false\n@when visible\n@slider n = 0\n{{1/n}}\n@end\n",
    );
    const before = s.getRevision();
    error(s.setControl("visible", true), "E_DIV_ZERO");
    expect(s.getRevision()).toBe(before);
    expect(s.setControls({ visible: true, n: 2 }).ok).toBe(true);
  });
});
describe("closed IR", () => {
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(
    JSON.parse(readFileSync("schemas/program.schema.json", "utf8")),
  );
  const source = "@slider n = 1\n@calc twice = n*2\n# Hello {{twice}}\n";
  it("round trips both object and JSON payloads", () => {
    const p = program(source),
      ir = encodeProgram(p);
    expect(validate(ir), JSON.stringify(validate.errors)).toBe(true);
    for (const payload of [ir, JSON.parse(JSON.stringify(ir))]) {
      const decoded = decodeProgram(payload);
      expect(decoded.ok, JSON.stringify(decoded.diagnostics)).toBe(true);
      expect(createSession(decoded.value).value.getRevision()).toEqual(
        createSession(p).value.getRevision(),
      );
    }
  });
  it("rejects nested unknown keys, invalid enums, source hashes and semantic tampering", () => {
    const mutations = [
      (p) => {
        p.extra = true;
      },
      (p) => {
        p.flow[0].extra = true;
      },
      (p) => {
        p.declarations[0].grid.ticks = 99;
      },
      (p) => {
        p.declarations[1].expression.operator = "**";
      },
      (p) => {
        p.declarations[0].span.start.line = 99;
      },
      (p) => {
        p.sourceSha256 = "0".repeat(64);
      },
      (p) => {
        p.flow[1].level = 7;
      },
      (p) => {
        p.metadata.locale = "xx";
      },
      (p) => {
        p.declarations[0].initial = NaN;
      },
      (p) => {
        p.declarations[0].name = "__proto__";
      },
      (p) => {
        p.flow[0].kind = "script";
      },
    ];
    for (const mutate of mutations) {
      const payload = JSON.parse(
        JSON.stringify(encodeProgram(program(source))),
      );
      mutate(payload);
      expect(decodeProgram(payload).ok).toBe(false);
    }
  });
  it("rejects cycles, accessors, classes and symbols before reading fields", () => {
    const cycle = {};
    cycle.self = cycle;
    for (const payload of [
      null,
      [],
      true,
      cycle,
      new Date(),
      { [Symbol("x")]: 1 },
      Object.defineProperty({}, "source", {
        get() {
          throw new Error("getter executed");
        },
        enumerable: true,
      }),
    ])
      expect(decodeProgram(payload).ok).toBe(false);
  });
  it("validates all fixture programs against the generated schema", () => {
    for (const fixture of fixtures.filter(
      (f) => !["csv", "json", "enrich"].includes(f.phase),
    )) {
      const result = compile(input(fixture.source));
      if (!result.ok) continue;
      expect(
        validate(encodeProgram(result.value)),
        fixture.id + JSON.stringify(validate.errors),
      ).toBe(true);
      expect(
        decodeProgram(JSON.parse(JSON.stringify(encodeProgram(result.value))))
          .ok,
        fixture.id,
      ).toBe(true);
    }
  });
});
describe("pure imports", () => {
  const bytes = (s) => new TextEncoder().encode(s),
    options = { name: "records" };
  for (const source of [
    'a,b\r\n"x,y","line\r\ntwo"\r\n',
    "a,b\rtrue,1\rfalse,2\r",
    'a,b\n"a""b",\n',
  ])
    it(`imports CSV ${JSON.stringify(source)}`, () =>
      expect(importCsv(bytes(source), options).ok).toBe(true));
  for (const source of [
    "",
    "\n",
    "a,a\n1,2",
    "a,b\n1",
    "a\n\n",
    'a\n"unclosed',
    'a\n"x"junk',
    'a\na"b',
  ])
    it(`rejects CSV ${JSON.stringify(source)}`, () =>
      error(importCsv(bytes(source), options), "E_IMPORT_SCHEMA"));
  for (const source of [
    "null",
    "{}",
    "[]",
    "[{}]",
    '[{"a":null}]',
    '[{"a":[]}]',
    '[{"a":true},{"b":true}]',
    '[{"a":true},{"a":1}]',
    '[{"a":1,"a":2}]',
    '[{"a":"\\ud800"}]',
    '[{"a":1e400}]',
    '[{"a":1},]',
    '[{"a":1}]garbage',
    '[{"a":"bad\ntext"}]',
  ])
    it(`rejects JSON ${source}`, () =>
      error(importJson(bytes(source), options), "E_IMPORT_SCHEMA"));
  it("maps headers deterministically and keeps complete typed schemas", () => {
    const result = importCsv(
      bytes("Élan,elan,1,__proto__,!!!\nx,y,z,a,b\n"),
      options,
    );
    expect(result.value.columns.map((c) => c.name)).toEqual([
      "Elan",
      "elan",
      "column_1",
      "proto",
      "column",
    ]);
    expect(compile(input(result.value.source)).ok).toBe(true);
    expect(importCsv(bytes("x\n"), options).value.columns[0].type).toBe("text");
    expect(
      importJson(
        bytes('[{"a":true,"b":"3","c":-0},{"c":2,"b":"4","a":false}]'),
        options,
      ).value.columns.map((c) => c.type),
    ).toEqual(["boolean", "text", "number"]);
  });
  it("requires exact explicit mappings without JSON coercion", () => {
    const columns = [{ input: "x", name: "value", type: "number" }];
    expect(importCsv(bytes("x\n2\n"), { ...options, columns }).ok).toBe(true);
    error(
      importCsv(bytes("x\ntext\n"), { ...options, columns }),
      "E_IMPORT_SCHEMA",
    );
    error(
      importJson(bytes('[{"x":"2"}]'), { ...options, columns }),
      "E_IMPORT_SCHEMA",
    );
    error(
      importCsv(bytes("x\n2\n"), { name: "constructor" }),
      "E_IMPORT_SCHEMA",
    );
    error(importCsv(Uint8Array.from([255]), options), "E_ENCODING");
  });
});
describe("deterministic properties", () => {
  it("conserves histogram observations across boundary values", () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10000, max: 10000 }), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 2, max: 30 }),
        (values, bins) => {
          const s = session(
            `@data d\nx:number\n${values.join("\n")}\n@end\n@chart histogram d (x: "x", bins: ${bins})\n`,
          );
          const chart = s.getRevision().nodes[0].chart;
          expect(chart.bins.reduce((sum, b) => sum + b.count, 0)).toBe(
            values.length,
          );
          expect(chart.bins).toHaveLength(bins);
        },
      ),
      { seed: 123456, numRuns: 1000 },
    ));
  it("retains stable order for equal sort keys in either direction", () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 30 }),
        fc.boolean(),
        (values, descending) => {
          const s = session(
            `@data d\nkey:number | index:number\n${values.map((v, i) => `${v} | ${i}`).join("\n")}\n@end\n@view sorted = d (sort: "key", descending: ${descending})\n`,
          );
          const rows = s.getRevision().tables.sorted.rows;
          expect(rows.map((r) => r.cells)).toEqual(
            values
              .map((v, i) => [v, i])
              .sort((a, b) => (a[0] - b[0]) * (descending ? -1 : 1)),
          );
        },
      ),
      { seed: 654321, numRuns: 1000 },
    ));
});
describe("static validation boundaries", () => {
  const bad = [
    ["@slider n = 0 (min: 2, max: 1)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (step: 0)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (step: 0.0000001)\n", "E_STATE_DOMAIN"],
    ["@slider n = 1e-7 (min: 0, max: 1)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (min: -1e10, max: 1)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (max: 1e10)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (step: 0.001, max: 1000)\n", "E_STATE_DOMAIN"],
    ["@slider n = 0 (min: true)\n", "E_PROPERTY_VALUE"],
    ["@slider n = 0 (min: 1+2)\n", "E_PROPERTY_VALUE"],
    ['@choice n = "x" ()\n', "E_PROPERTY_REQUIRED"],
    ['@choice n = "x" (options: [])\n', "E_PROPERTY_VALUE"],
    ['@choice n = "x" (options: [1])\n', "E_PROPERTY_VALUE"],
    ['@choice n = "x" (options: [""])\n', "E_PROPERTY_VALUE"],
    ['@choice n = "x" (options: ["y"])\n', "E_STATE_DOMAIN"],
    ["@when 1\nhello\n@end\n", "E_TYPE"],
    ["{{ [1,2] }}\n", "E_TYPE"],
    ["@let n = [1,2]\n{{n}}\n", "E_TYPE"],
    ["@let n = 1\n@view v = n\n", "E_TYPE"],
    ["@let n = 1\n@table n\n", "E_TYPE"],
    ["@data d\nx:number\n@end\n@view v = d (where: 1)\n", "E_TYPE"],
    [
      '@data d\nx:number\n@end\n@view v = d (sort: "unknown")\n',
      "E_COLUMN_UNKNOWN",
    ],
  ];
  for (const [source, code] of bad)
    it(`rejects ${source.trim()}`, () => error(compile(input(source)), code));
  it("accepts negative and exponent grids and both endpoints", () => {
    const s = session("@slider n = 1 (min: -1, max: 1, step: 1e-1)\n");
    expect(s.setControl("n", -1).ok).toBe(true);
    expect(s.setControl("n", -0.3).ok).toBe(true);
    for (const value of [
      1.1,
      0.30000000000000004,
      1e-7,
      1e100,
      NaN,
      Infinity,
      true,
      "1",
    ])
      error(s.setControl("n", value), "E_STATE_DOMAIN");
  });
  it("reports every strongly connected component in source order", () => {
    const result = compile(
      input(
        "@calc a = b\n@calc b = a\n@calc c = c\n@calc d = if(true,1,e)\n@calc e = d\n",
      ),
    );
    error(result, "E_CYCLE");
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.map((d) => d.related.length)).toEqual([2, 1, 2]);
    expect(result.diagnostics.map((d) => d.span.start.line)).toEqual([1, 3, 4]);
  });
  it("reports duplicate and unknown tokens with related original spans", () => {
    const result = compile(
      input("@let item = 1\n@let item = 2\n@calc a = missing\n"),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "E_NAME_DUPLICATE",
      "E_NAME_UNKNOWN",
    ]);
    expect(result.diagnostics[0].span.start).toEqual({
      offset: 19,
      line: 2,
      column: 6,
    });
    expect(result.diagnostics[0].related[0].span.start.offset).toBe(5);
  });
  it("caps diagnostics with an explicit final limit", () => {
    const result = compile(
      input(
        Array.from({ length: 101 }, (_, i) => `@calc a${i} = missing${i}`).join(
          "\n",
        ),
      ),
    );
    expect(result.diagnostics).toHaveLength(100);
    expect(result.diagnostics.at(-1).code).toBe("E_LIMIT");
    const limited = compile(input("@calc a = x\n@calc b = y\n"), {
      limits: { diagnostics: 1 },
    });
    expect(limited.diagnostics).toHaveLength(1);
    expect(limited.diagnostics[0].code).toBe("E_LIMIT");
  });
});
describe("chart domains and static matrix", () => {
  const data =
    "@data d\nx:number | label:text | y:number | flag:boolean\n3 | C | 0 | false\n1 | A | 0 | true\n2 | B | 0 | false\n@end\n";
  for (const [options, code] of [
    ['line d (y:"y")', "E_PROPERTY_REQUIRED"],
    ['line d (x:"x")', "E_PROPERTY_REQUIRED"],
    ['line d (x:"x",y:"y",bins:2)', "E_PROPERTY_VALUE"],
    ['histogram d (x:"x",bins:1)', "E_PROPERTY_VALUE"],
    ['histogram d (x:"x",bins:2.5)', "E_PROPERTY_VALUE"],
    ['line d (x:"missing",y:"y")', "E_COLUMN_UNKNOWN"],
    ['line d (x:"flag",y:"y")', "E_TYPE"],
    ['scatter d (x:"label",y:"y")', "E_TYPE"],
    ['line d (x:"x",y:"missing")', "E_COLUMN_UNKNOWN"],
    ['line d (x:"x",y:"label")', "E_TYPE"],
    ['line d (x:"x",y:row.label)', "E_TYPE"],
    ['line d (x:"x",y:[])', "E_CHART_SERIES"],
    ['line d (x:"x",y:["y","y"])', "E_CHART_SERIES"],
    ['line d (x:"x",y:[1])', "E_CHART_SERIES"],
    ['line d (x:"x",y:"y",select:"n")', "E_SELECTION_TARGET"],
    ['line d (x:"x",y:"y",select:unknown)', "E_SELECTION_TARGET"],
  ])
    it(options, () =>
      error(compile(input(data + `@chart ${options}\n`)), code),
    );
  for (const type of ["line", "area", "bar", "scatter", "pie", "donut"])
    it(`prepares ${type} ordering, zero values and stable IDs`, () => {
      const chart = session(
        data + `@chart ${type} d (x:"x",y:["y"])\n`,
      ).getRevision().nodes[0].chart;
      const order = type === "line" || type === "area" ? [1, 2, 3] : [3, 1, 2];
      expect(chart.points.map((p) => p.x)).toEqual(order);
      expect(chart.table.rows.map((r) => r.cells[0])).toEqual(order);
      expect(
        chart.points.every((p) => p.id === `${chart.id}:${p.rowId}:0`),
      ).toBe(true);
      expect(chart.points.map((p) => p.y)).toEqual([0, 0, 0]);
    });
  it("keeps textual categories and validates exact choice selections", () => {
    const source =
      data +
      '@choice selected = "A" (options:["A","B","C"])\n@chart line d (x:"label",y:"y",select:selected)\n';
    const s = session(source);
    expect(s.getRevision().nodes[1].chart.points.map((p) => p.x)).toEqual([
      "C",
      "A",
      "B",
    ]);
    error(
      createSession(program(source.replace('["A","B","C"]', '["A","B"]'))),
      "E_SELECTION_DOMAIN",
    );
  });
  for (const type of [
    "line",
    "area",
    "bar",
    "scatter",
    "pie",
    "donut",
    "histogram",
  ])
    it(`rejects non-finite ${type} domains`, () => {
      const rows =
        type === "pie" || type === "donut"
          ? "1 | 1e308\n2 | 1e308"
          : "-1e308 | -1e308\n1e308 | 1e308";
      const source = `@data d\nx:number | y:number\n${rows}\n@end\n@chart ${type} d (x:"x"${type === "histogram" ? "" : ',y:"y"'})\n`;
      error(createSession(program(source)), "E_CHART_DOMAIN");
    });
  it("rejects constant-domain expansion overflow and collapsed histogram edges", () => {
    for (const type of ["line", "histogram"])
      error(
        createSession(
          program(
            `@data d\nx:number | y:number\n1.79e308 | 1\n@end\n@chart ${type} d (x:"x"${type === "line" ? ',y:"y"' : ""})\n`,
          ),
        ),
        "E_CHART_DOMAIN",
      );
    error(
      createSession(
        program(
          '@data d\nx:number\n1\n1.0000000000000002\n@end\n@chart histogram d (x:"x",bins:30)\n',
        ),
      ),
      "E_CHART_DOMAIN",
    );
  });
  it("guards chart evaluation only with false conditions", () => {
    const source =
      '@data d\nx:number | y:number\n1 | -1\n@end\n@toggle show = false\n@when show\n@chart pie d (x:"x",y:"y")\n@end\n';
    const s = session(source),
      before = s.getRevision();
    error(s.setControl("show", true), "E_CHART_VALUE");
    expect(s.getRevision()).toBe(before);
    error(
      createSession(
        program(source.replace("@when show", '@details "Not lazy"')),
      ),
      "E_CHART_VALUE",
    );
  });
});
describe("semantic flow and source fidelity", () => {
  it("resolves all normalized Markdown forms without executing HTML", () => {
    const source =
      '# Title\n\n[linked](https://example.com "title") and ![image](assets/a.png "Image")\n\n> **bold** *em* ~~deleted~~ `code`\n\n---\n\n1. item\n\n- [x] done\n- [ ] open\n\n| One | Two |\n| :- | -: |\n| A | B |\n\nfirst  \nsecond\n\n```js\nalert(1)\n```\n\n<div>literal</div>\n\n[reference][r]\n\n![alt][r]\n\n[r]: https://example.com "Referenced"\n';
    const p = program(source),
      s = createSession(p);
    expect(s.ok).toBe(true);
    expect(encodeProgram(p).source).toBe(source);
    expect(decodeProgram(JSON.parse(JSON.stringify(p))).ok).toBe(true);
    const serialized = JSON.stringify(s.value.getRevision().nodes);
    expect(serialized).toContain('"tag":"table"');
    expect(serialized).toContain('"kind":"image"');
    expect(serialized).toContain('"tag":"blockquote"');
    expect(serialized).toContain("<div>literal</div>");
  });
  it("resolves data tables, empty schemas, details and empty documents", () => {
    for (const source of [
      "",
      "<!-- note -->\n",
      "@data d\nx:number\n@end\n@table d\n",
      '@data d\nx:number\n1\n@end\n@table d (title:"Values")\n',
      "@details\ninside\n@end\n",
    ])
      expect(createSession(program(source)).ok).toBe(true);
  });
  it("sorts text by code point and booleans before preserving stable ties", () => {
    const s = session(
      '@data d\nname:text | flag:boolean\n😀 | true\n\uE000 | false\nA | false\n@end\n@view text_order = d (sort:"name")\n@view bool_order = d (sort:"flag")\n',
    );
    expect(
      s.getRevision().tables.text_order.rows.map((r) => r.cells[0]),
    ).toEqual(["A", "\uE000", "😀"]);
    expect(
      s.getRevision().tables.bool_order.rows.map((r) => r.cells[0]),
    ).toEqual(["\uE000", "A", "😀"]);
  });
});
describe("resource ceilings", () => {
  const data = (rows, columns = 1) =>
    `@data d\n${Array.from({ length: columns }, (_, i) => `c${i}:number`).join(" | ")}\n${Array.from({ length: rows }, (_, i) => Array.from({ length: columns }, () => String(i)).join(" | ")).join("\n")}\n@end\n`;
  it("enforces authored labels, choices and exact slider ceilings", () => {
    for (const [limit, source, overflow] of [
      [
        "labelCodePoints",
        `@toggle n = true (label:"${"x".repeat(200)}")\n`,
        `@toggle n = true (label:"${"x".repeat(201)}")\n`,
      ],
      [
        "choiceOptions",
        `@choice n = "x0" (options:[${Array.from({ length: 50 }, (_, i) => `"x${i}"`).join(",")}])\n`,
        `@choice n = "x0" (options:[${Array.from({ length: 51 }, (_, i) => `"x${i}"`).join(",")}])\n`,
      ],
      [
        "choiceOptionCodePoints",
        `@choice n = "${"x".repeat(120)}" (options:["${"x".repeat(120)}"])\n`,
        `@choice n = "x" (options:["${"x".repeat(121)}"])\n`,
      ],
    ]) {
      expect(compile(input(source)).ok, limit).toBe(true);
      error(compile(input(overflow)), "E_LIMIT");
    }
    expect(
      compile(input("@slider n = 0 (min:0,max:0.1,step:0.000001)\n")).ok,
    ).toBe(true);
    error(
      compile(input("@slider n = 0 (min:0,max:0.100001,step:0.000001)\n")),
      "E_STATE_DOMAIN",
    );
    expect(
      compile(input("@slider n = 1000000000 (min:999999999,max:1000000000)\n"))
        .ok,
    ).toBe(true);
    error(
      compile(input("@slider n = 1000000000 (min:999999999,max:1000000001)\n")),
      "E_STATE_DOMAIN",
    );
    error(
      compile(input('@details "' + "x".repeat(201) + '"\nbody\n@end\n')),
      "E_LIMIT",
    );
  });
  for (const [name, count, chart] of [
    ["chartRows", 2000, 'scatter d (x:"c0",y:"c0")'],
    ["chartCategories", 200, 'bar d (x:"c0",y:"c0")'],
    ["chartSectors", 24, 'pie d (x:"c0",y:"c0")'],
  ])
    it(`checks ${name} at and above its ceiling`, () => {
      expect(createSession(program(data(count) + `@chart ${chart}\n`)).ok).toBe(
        true,
      );
      const result = createSession(
        program(data(count + 1) + `@chart ${chart}\n`),
      );
      error(result, "E_LIMIT");
      expect(result.diagnostics[0].details.limitName).toBe(name);
    });
  it("checks series, per-chart marks and document marks", () => {
    const source = data(2000, 6),
      chart = '@chart scatter d (x:"c0",y:["c0","c1","c2","c3","c4","c5"])\n';
    expect(
      createSession(program(source + chart)).value.getRevision().nodes[0].chart
        .points,
    ).toHaveLength(12000);
    const two = '@chart scatter d (x:"c0",y:["c0","c1"])\n';
    expect(
      createSession(program(source + chart.repeat(2) + two.repeat(2))).ok,
    ).toBe(true);
    const failed = createSession(
      program(source + chart.repeat(2) + two.repeat(3)),
    );
    error(failed, "E_LIMIT");
    expect(failed.diagnostics[0].details.limitName).toBe("documentChartMarks");
    error(
      compile(
        input(
          data(1, 7) +
            '@chart scatter d (x:"c0",y:["c0","c1","c2","c3","c4","c5","c6"])\n',
        ),
      ),
      "E_CHART_SERIES",
    );
  });
  it("shares evaluation budget across views and rolls back exhausted candidates", () => {
    const source =
      data(20) +
      '@toggle active = false\n@when active\n@chart scatter d (x:"c0",y:row.c0*2)\n@end\n';
    const compiled = program(source, { limits: { evaluationOperations: 10 } });
    const s = createSession(compiled).value,
      before = s.getRevision();
    error(s.setControl("active", true), "E_LIMIT");
    expect(s.getRevision()).toBe(before);
    const view =
      data(10) +
      "@view a = d (where:row.c0>=0)\n@view b = a (where:row.c0>=0)\n";
    error(
      createSession(program(view, { limits: { evaluationOperations: 50 } })),
      "E_LIMIT",
    );
  });
  it("does not reset compile budgets between parsing and binding", () => {
    const source = "@calc result = 1+2\n{{ result }}\n";
    let first;
    for (let limit = 1; limit < 500; limit++)
      if (compile(input(source), { limits: { compileOperations: limit } }).ok) {
        first = limit;
        break;
      }
    expect(first).toBeGreaterThan(10);
    expect(
      compile(input(source), { limits: { compileOperations: first } }).ok,
    ).toBe(true);
    error(
      compile(input(source), { limits: { compileOperations: first - 1 } }),
      "E_LIMIT",
    );
  });
  it("honors stricter runtime limits and rejects weakened or unknown limits", () => {
    const source = data(2) + '@chart line d (x:"c0",y:"c0")\n';
    for (const limits of [
      { chartRows: 1 },
      { chartMarks: 1 },
      { documentChartMarks: 1 },
    ])
      error(createSession(program(source, { limits })), "E_LIMIT");
    for (const limits of [
      { unknown: 1 },
      { sourceBytes: 2097153 },
      { evaluationOperations: 0 },
      { chartRows: NaN },
    ])
      error(compile(input(source), { limits }), "E_LIMIT");
    error(
      compile(input("@slider n = 0 (step:0.1,max:1)\n"), {
        limits: { sliderTicks: 5 },
      }),
      "E_LIMIT",
    );
    error(
      compile(input("@slider n = 0 (min:-1,max:1,step:0.001)\n"), {
        limits: { sliderFractionalDigits: 2 },
      }),
      "E_STATE_DOMAIN",
    );
    error(decodeProgram({}, { limits: { unknown: 1 } }), "E_LIMIT");
  });
  it("bounds untrusted IR nesting and traversal without executing accessors", () => {
    let payload = {};
    for (let i = 0; i < 257; i++) payload = { child: payload };
    error(decodeProgram(payload), "E_LIMIT");
    error(
      decodeProgram(encodeProgram(program("text\n")), {
        limits: { compileOperations: 1 },
      }),
      "E_LIMIT",
    );
    const bad = JSON.parse(JSON.stringify(program("text\n")));
    bad.source = "@calc result = unknown\n";
    error(decodeProgram(bad), "E_NAME_UNKNOWN");
  });
  it("bounds imports before allocation and preserves precise scalar text", () => {
    const bytes = (s) => new TextEncoder().encode(s),
      options = { name: "records" };
    error(importCsv(new Uint8Array(5242881), options), "E_LIMIT");
    error(importJson(new Uint8Array(5242881), options), "E_LIMIT");
    expect(importCsv(bytes('x\n""\n'), options).value.source).toContain('""');
    expect(
      importCsv(bytes("x,x!\n1,2\n"), options).value.columns.map((c) => c.name),
    ).toEqual(["x", "x_2"]);
    error(importCsv(bytes("x\n" + "a".repeat(65537)), options), "E_LIMIT");
    error(
      importJson(bytes('[{"x":"' + "a".repeat(65537) + '"}]'), options),
      "E_LIMIT",
    );
    error(importJson(bytes('[{"x":"unfinished'), options), "E_IMPORT_SCHEMA");
    error(importJson(bytes('[{"x":+1}]'), options), "E_IMPORT_SCHEMA");
  });
});
describe("examples and generated contracts", () => {
  for (const name of [
    "minimal",
    "article",
    "report",
    "guide",
    "chart-atlas",
    "all-functions",
    "local-image",
    "import-after",
  ])
    it(`compiles and evaluates ${name}`, () => {
      const source = readFileSync(`examples/${name}.tinta`, "utf8");
      const p = program(source);
      expect(createSession(p).ok).toBe(true);
      expect(
        decodeProgram(JSON.parse(JSON.stringify(encodeProgram(p)))).ok,
      ).toBe(true);
    });
});
describe("value boundaries and retained source locations", () => {
  it("normalizes table negative zero through IR, values and decoded programs", () => {
    const p = program(
      '@data d\nx:number\n-0\n@end\n@calc total = sum(d,"x")\n',
    );
    expect(Object.is(p.declarations[0].table.rows[0].cells[0], -0)).toBe(false);
    expect(
      Object.is(createSession(p).value.getRevision().values.total, -0),
    ).toBe(false);
    expect(decodeProgram(encodeProgram(p)).ok).toBe(true);
  });
  it("points unknown chart columns at the static option token", () => {
    const source =
      '@data d\nx:number\n@end\n@chart line d (x:"absent",y:"x")\n';
    const result = compile(input(source));
    error(result, "E_COLUMN_UNKNOWN");
    const span = result.diagnostics[0].span;
    expect(source.slice(span.start.offset, span.end.offset)).toBe('"absent"');
  });
  it("caps subscriber diagnostics without undoing the committed revision", () => {
    const s = session("@slider n = 1\n");
    for (let i = 0; i < 101; i++)
      s.subscribe(() => {
        throw new Error("host");
      });
    const result = s.setControl("n", 2);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(100);
    expect(result.diagnostics.at(-1).code).toBe("E_LIMIT");
    expect(s.getRevision().number).toBe(1);
  });
  it("validates all supported function arities", () => {
    const signatures = {
      if: [3],
      min: [2],
      max: [2],
      round: [1, 2],
      pow: [2],
      count: [1],
      sum: [2],
      mean: [2],
      fixed: [2],
      percent: [1],
      money: [1],
    };
    for (const [name, allowed] of Object.entries(signatures)) {
      for (let count = 0; count <= 4; count++) {
        if (allowed.includes(count)) continue;
        error(
          compile(
            input(
              `@calc result = ${name}(${Array(count).fill("1").join(",")})\n`,
            ),
          ),
          "E_FUNCTION_ARITY",
        );
      }
    }
  });
});
describe("bounded malformed-input properties", () => {
  it("returns diagnostics for arbitrary import bytes without throwing", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        for (const importer of [importCsv, importJson]) {
          const result = importer(bytes, { name: "records" });
          expect(typeof result.ok).toBe("boolean");
          if (result.ok)
            expect(compile(input(result.value.source)).ok).toBe(true);
          else expect(result.diagnostics.length).toBeGreaterThan(0);
        }
      }),
      { seed: 357911, numRuns: 1000 },
    );
  });
  it("rejects arbitrary JSON values as programs without coercion or mutation", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const before = JSON.stringify(payload);
        const result = decodeProgram(payload);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(payload)).toBe(before);
      }),
      { seed: 246810, numRuns: 1000 },
    );
  });
});
