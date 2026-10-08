import type {
  ChartPoint,
  ChartSpec,
  ControlDefinition,
  HistogramBin,
  PreparedChart,
  Scalar,
  TableValue,
} from "@tinta/types";
import { fail, label } from "./common.js";
import { evaluate, type Environment } from "./expression.js";
import { inDomain } from "./grid.js";
import { numericDomain } from "./chart-presentation.js";

function domain(
  values: readonly number[],
  zero: boolean,
  chart: ChartSpec,
): void {
  if (!values.length) return;
  try {
    numericDomain(values, zero);
  } catch {
    fail("E_CHART_DOMAIN", chart.span, "evaluate");
  }
}
export function prepare(
  chart: ChartSpec,
  table: TableValue,
  env: Environment,
  controls: ReadonlyMap<string, ControlDefinition>,
): PreparedChart {
  const budget = env.budget;
  budget.limit("chartRows", table.rows.length, chart.span);
  const xIndex = table.columns.findIndex((c) => c.name === chart.x);
  const numericX = table.columns[xIndex]!.type === "number";
  const sector = chart.kind === "pie" || chart.kind === "donut";
  if (sector) budget.limit("chartSectors", table.rows.length, chart.span);
  if (
    chart.kind === "bar" ||
    (!numericX && (chart.kind === "line" || chart.kind === "area"))
  )
    budget.limit("chartCategories", table.rows.length, chart.span);
  const rows = [...table.rows];
  if (numericX && (chart.kind === "line" || chart.kind === "area"))
    rows.sort((a, b) => {
      budget.charge(chart.span);
      return (a.cells[xIndex] as number) - (b.cells[xIndex] as number);
    });
  const xs = rows.map((row) => row.cells[xIndex] as number | string);
  if (
    chart.kind !== "scatter" &&
    chart.kind !== "histogram" &&
    new Set(xs).size !== xs.length
  )
    fail("E_CHART_DUPLICATE_X", chart.span, "evaluate");
  if (chart.select)
    for (const x of xs)
      if (!inDomain(controls.get(chart.select)!, x))
        fail("E_SELECTION_DOMAIN", chart.span, "evaluate");
  const series =
    chart.y?.kind === "columns"
      ? chart.y.columns.map((name) => ({ id: name, label: label(name) }))
      : chart.y
        ? [{ id: "value", label: chart.yLabel }]
        : [];
  const points: ChartPoint[] = [];
  const bins: HistogramBin[] = [];
  if (chart.kind === "histogram" && rows.length) {
    const values = xs as number[];
    let lo = Math.min(...values),
      hi = Math.max(...values);
    if (lo === hi) {
      const delta = Math.max(0.5, Math.abs(lo) * 0.05);
      lo -= delta;
      hi += delta;
    }
    if (
      !Number.isFinite(lo) ||
      !Number.isFinite(hi) ||
      !Number.isFinite(hi - lo) ||
      hi <= lo
    )
      fail("E_CHART_DOMAIN", chart.span, "evaluate");
    const count = chart.bins!;
    const edges = Array.from({ length: count + 1 }, (_, i) =>
      i === 0 ? lo : i === count ? hi : lo + (i * (hi - lo)) / count,
    );
    for (let i = 0; i < count; i++) {
      budget.charge(chart.span);
      if (!Number.isFinite(edges[i + 1]) || edges[i + 1]! <= edges[i]!)
        fail("E_CHART_DOMAIN", chart.span, "evaluate");
      bins.push({
        id: `${chart.id}:bin:${i}`,
        lower: edges[i]!,
        upper: edges[i + 1]!,
        upperInclusive: i === count - 1,
        count: 0,
      });
    }
    const counts = bins.map(() => 0);
    for (const x of values) {
      budget.charge(chart.span);
      const index = bins.findIndex(
        (bin) =>
          x >= bin.lower &&
          (x < bin.upper || (bin.upperInclusive && x === bin.upper)),
      );
      counts[index]!++;
    }
    bins.forEach((bin, i) => {
      bins[i] = { ...bin, count: counts[i]! };
    });
  } else if (chart.y) {
    let total = 0;
    for (const row of rows) {
      budget.charge(chart.span);
      const fields = new Map<string, Scalar>(
        table.columns.map((c, i) => [c.name, row.cells[i]!]),
      );
      const ys =
        chart.y.kind === "columns"
          ? chart.y.columns.map(
              (name) =>
                row.cells[
                  table.columns.findIndex((c) => c.name === name)
                ] as number,
            )
          : [evaluate(chart.y.expression, { ...env, row: fields }) as number];
      ys.forEach((y, i) => {
        budget.charge(chart.span);
        if (!Number.isFinite(y) || (sector && y < 0))
          fail("E_CHART_VALUE", chart.span, "evaluate");
        if (sector) {
          total += y;
          if (!Number.isFinite(total))
            fail("E_CHART_DOMAIN", chart.span, "evaluate");
        }
        points.push({
          id: `${chart.id}:${row.id}:${i}`,
          rowId: row.id,
          seriesIndex: i,
          x: row.cells[xIndex] as number | string,
          y,
        });
      });
    }
    if (!sector) {
      if (numericX && chart.kind !== "bar")
        domain(xs as number[], false, chart);
      domain(
        points.map((p) => p.y),
        chart.kind === "bar" || chart.kind === "area",
        chart,
      );
      // Any series can remain visible alone after a presentation-only toggle.
      for (let index = 0; index < series.length; index++) {
        domain(
          points
            .filter((point) => point.seriesIndex === index)
            .map((point) => point.y),
          chart.kind === "bar" || chart.kind === "area",
          chart,
        );
      }
    }
  }
  budget.limit("chartMarks", points.length + bins.length, chart.span);
  return {
    id: chart.id,
    type: chart.kind,
    title: chart.title,
    xLabel: chart.xLabel,
    yLabel: chart.yLabel,
    source: chart.source,
    ...(chart.select ? { select: chart.select } : {}),
    series,
    points,
    bins,
    table: { columns: table.columns, rows },
    empty: rows.length === 0,
  };
}
