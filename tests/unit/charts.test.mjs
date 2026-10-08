import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  compile,
  createSession,
  numericDomain,
  chartPresentation,
  legendKey,
} from "../../packages/engine/dist/index.js";
import {
  chartScene,
  coordinate,
  tickLabel,
} from "../../packages/charts/dist/index.js";

function prepared(
  type,
  rows = "1 | 2 | 4\n2 | -1 | 3",
  options = 'y: ["a", "b"]',
  xType = "number",
) {
  const result = compile({
    text: `@data values\nx:${xType} | a:number | b:number\n${rows}\n@end\n@chart ${type} values (x: "x"${options ? `, ${options}` : ""})`,
    profile: "tinta",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const session = createSession(result.value);
  expect(session.ok, JSON.stringify(session)).toBe(true);
  return session.value.getRevision().nodes.find((node) => node.kind === "chart")
    .chart;
}
describe("safe chart scenes", () => {
  for (const type of [
    "line",
    "area",
    "bar",
    "scatter",
    "pie",
    "donut",
    "histogram",
  ]) {
    test(`${type} has finite deterministic geometry at supported widths`, () => {
      const chart = prepared(
        type,
        "1 | 2 | 4\n2 | 0 | 3",
        type === "histogram"
          ? "bins: 2"
          : type === "pie" || type === "donut"
            ? 'y: "a"'
            : 'y: ["a", "b"]',
      );
      for (const width of [0, 280, 320, 390, 720, 768, 800, 1024, 1440]) {
        const scene = chartScene(chart, width, new Set(), 1);
        expect(scene.width).toBe(Math.min(800, Math.max(280, width)));
        expect(scene.height).toBe(
          Math.round(Math.max(240, Math.min(400, scene.width * 0.55))),
        );
        expect(JSON.stringify(scene)).not.toMatch(/NaN|Infinity|undefined/);
        expect(scene.nodes.length).toBeGreaterThan(0);
        expect(scene).toEqual(chartScene(chart, width, new Set(), 1));
        expect(
          scene.nodes.every((node) =>
            ["path", "rect", "circle", "line", "text"].includes(node.tag),
          ),
        ).toBe(true);
      }
    });
  }
  test("categorical axes, negative baselines, visible domains and series identity", () => {
    for (const type of ["line", "area", "bar"]) {
      const chart = prepared(
        type,
        "Alpha | -2 | 4\nBeta | 5 | 3",
        'y: ["a", "b"]',
        "text",
      );
      expect(chartPresentation(chart).yDomain).toEqual([-2, 5]);
      expect(chartPresentation(chart, new Set(["a"])).yDomain).toEqual(
        type === "line" ? [3, 4] : [0, 4],
      );
      expect(
        chartScene(chart, 390)
          .nodes.filter((n) => n.tag === "text")
          .map((n) => n.text),
      ).toContain("Beta");
      expect(chartScene(chart, 390, new Set(["a", "b"])).message).toBe(
        "All series are hidden.",
      );
    }
  });
  test("pie visibility, zero categories, visible totals and tiny totals", () => {
    for (const type of ["pie", "donut"]) {
      const chart = prepared(type, "1 | 2 | 0\n2 | 0 | 0", 'y: ["a"]');
      expect(legendKey(chart, 0)).toBe("1");
      expect(chartPresentation(chart).total).toBe(2);
      expect(
        chartScene(chart, 720).nodes.filter((n) => n.tag === "path"),
      ).toHaveLength(1);
      expect(chartScene(chart, 720, new Set(["1"])).message).toBe(
        "All visible values are zero.",
      );
      expect(chartScene(chart, 720, new Set(["1", "2"])).message).toBe(
        "All categories are hidden.",
      );
      const tiny = {
        ...chart,
        points: chart.points.map((point) => ({
          ...point,
          y: Number.MIN_VALUE,
        })),
      };
      expect(JSON.stringify(chartScene(tiny, 720))).not.toMatch(/Infinity|NaN/);
      expect(() =>
        chartPresentation({
          ...chart,
          points: chart.points.map((point) => ({
            ...point,
            y: Number.MAX_VALUE,
          })),
        }),
      ).toThrow("E_CHART_DOMAIN");
    }
  });
  test("empty scenes, one-point domains, tick precision and finite rejection", () => {
    const chart = prepared("line", "1 | 2 | 4");
    expect(chartPresentation(chart).xDomain).toEqual([0, 2]);
    expect(numericDomain([100, 100])).toEqual([95, 105]);
    expect(numericDomain([0], true)).toEqual([-1, 1]);
    expect(() =>
      numericDomain([-Number.MAX_VALUE, Number.MAX_VALUE]),
    ).toThrow();
    expect(() => coordinate(Infinity)).toThrow();
    expect(coordinate(-0.0001)).toBe("0");
    expect(coordinate(1.23456)).toBe("1.235");
    expect(tickLabel("😀".repeat(15))).toBe("😀".repeat(14) + "…");
    expect(tickLabel("short")).toBe("short");
    expect(() => chartScene(chart, NaN)).toThrow();
    expect(chartScene({ ...chart, points: [], empty: true }, 720).message).toBe(
      "No data matches the current choices.",
    );
    expect(chartScene(prepared("histogram", "", "bins: 2"), 720).nodes).toEqual(
      [],
    );
  });
  test("six scatter shapes and stable categorical thinning", () => {
    const base = prepared("scatter");
    const chart = {
      ...base,
      series: Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        label: String(i),
      })),
      points: Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        rowId: "row",
        x: 1,
        y: i,
        seriesIndex: i,
      })),
    };
    const paths = chartScene(chart, 280).nodes.filter(
      (node) => node.tag === "path",
    );
    expect(new Set(paths.map((node) => node.attributes.d)).size).toBe(6);
    const categories = prepared(
      "bar",
      Array.from({ length: 20 }, (_, i) => `Category${i} | 1 | 2`).join("\n"),
      'y: "a"',
      "text",
    );
    const labels = chartScene(categories, 280)
      .nodes.filter((node) => node.tag === "text")
      .map((node) => node.text);
    expect(labels).toContain("Category19");
    expect(labels).not.toContain("Category1");
  });
});
test("histogram conservation over exact boundaries and seeded finite observations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -10000, max: 10000 }), {
        minLength: 1,
        maxLength: 100,
      }),
      fc.integer({ min: 2, max: 30 }),
      (values, bins) => {
        const chart = prepared(
          "histogram",
          values.map((x) => `${x} | 0 | 0`).join("\n"),
          `bins: ${bins}`,
        );
        expect(chart.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(
          values.length,
        );
        for (const x of values)
          expect(
            chart.bins.filter(
              (bin) =>
                x >= bin.lower &&
                (x < bin.upper || (bin.upperInclusive && x === bin.upper)),
            ),
          ).toHaveLength(1);
      },
    ),
    { seed: 42017, numRuns: 1000 },
  );
  expect(
    prepared(
      "histogram",
      "0 | 0 | 0\n1 | 0 | 0\n2 | 0 | 0\n3 | 0 | 0\n4 | 0 | 0",
      "bins: 2",
    ).bins.map((b) => b.count),
  ).toEqual([2, 3]);
  expect(
    prepared("histogram", "10 | 0 | 0\n10 | 0 | 0", "bins: 2").bins.map(
      (b) => b.count,
    ),
  ).toEqual([0, 2]);
});

test("locked geometry uses exact margins, zero baselines and normalized precision", () => {
  const chart = prepared("line", "0 | 0 | 1\n10 | 10 | 2", 'y: "a"');
  const scene = chartScene(chart, 720);
  expect(scene.height).toBe(396);
  expect(scene.nodes.filter((node) => node.tag === "path")).toEqual([
    {
      tag: "path",
      attributes: {
        d: "M64,348L700,20",
        fill: "none",
        stroke: "#0072B2",
        "stroke-width": "2",
        "stroke-dasharray": "none",
      },
    },
  ]);
  expect(
    scene.nodes
      .filter((node) => node.tag === "circle")
      .map((node) => [
        node.attributes.cx,
        node.attributes.cy,
        node.attributes.r,
      ]),
  ).toEqual([
    ["64", "348", "4"],
    ["64", "348", "12"],
    ["700", "20", "4"],
    ["700", "20", "12"],
  ]);
  const area = chartScene({ ...chart, type: "area" }, 720);
  expect(area.nodes.find((node) => node.attributes["fill-opacity"])).toEqual({
    tag: "path",
    attributes: {
      d: "M64,348L700,20L700,348L64,348Z",
      fill: "#0072B2",
      "fill-opacity": "0.15",
    },
  });
});

for (const type of [
  "line",
  "area",
  "bar",
  "scatter",
  "pie",
  "donut",
  "histogram",
]) {
  test(`${type} rejects boolean x and invalid y through source-located diagnostics`, () => {
    const data =
      "@data values\nx:boolean | y:text | n:number\ntrue | text | 1\n@end\n";
    for (const options of [
      `x: "x"${type === "histogram" ? "" : ', y: "n"'}`,
      `x: "n", y: "y"`,
    ]) {
      const result = compile({
        text: data + `@chart ${type} values (${options})`,
        profile: "tinta",
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0].code).toBe(
        type === "histogram" && options.includes('y: "y"')
          ? "E_PROPERTY_VALUE"
          : "E_TYPE",
      );
      expect(result.diagnostics[0].span.start.line).toBeGreaterThan(0);
    }
  });
}

test("invalid legend-visible series domains reject the whole candidate before commit", () => {
  const source = `@toggle extreme = false
@data values
x:number | a:number | b:number
1 | 1.79e308 | 1e308
@end
@view selected = values (where: extreme)
@chart line selected (x: "x", y: ["a", "b"])
`;
  const compiled = compile({ text: source, profile: "tinta" });
  expect(compiled.ok).toBe(true);
  const created = createSession(compiled.value);
  expect(created.ok).toBe(true);
  const session = created.value;
  const before = session.getRevision();
  const result = session.setControl("extreme", true);
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0].code).toBe("E_CHART_DOMAIN");
  expect(session.getRevision()).toBe(before);
  expect(session.setControl("extreme", false).ok).toBe(true);
});
