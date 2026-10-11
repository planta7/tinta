import type { PreparedChart } from "@tinta-lang/types";

/** Viewport-independent presentation derivation; never changes document state. */
export function numericDomain(
  values: readonly number[],
  zero = false,
): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (zero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    const delta = Math.max(1, Math.abs(lo) * 0.05);
    lo -= delta;
    hi += delta;
  }
  if (
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    !Number.isFinite(hi - lo) ||
    hi <= lo
  ) {
    throw new Error("E_CHART_DOMAIN");
  }

  return [lo, hi];
}

export function legendKey(chart: PreparedChart, index: number): string {
  const point = chart.points[index]!;
  return chart.type === "pie" || chart.type === "donut"
    ? JSON.stringify(point.x)
    : chart.series[point.seriesIndex]!.id;
}

export function chartPresentation(
  chart: PreparedChart,
  hidden: ReadonlySet<string> = new Set(),
) {
  const sector = chart.type === "pie" || chart.type === "donut";
  const points = chart.points.filter(
    (_, i) => !hidden.has(legendKey(chart, i)),
  );
  const total = sector ? points.reduce((sum, point) => sum + point.y, 0) : 0;
  if (!Number.isFinite(total)) throw new Error("E_CHART_DOMAIN");
  const message = chart.empty
    ? "No data matches the current choices."
    : !points.length && chart.type !== "histogram"
      ? sector
        ? "All categories are hidden."
        : "All series are hidden."
      : sector && total === 0
        ? "All visible values are zero."
        : "";
  const numeric = typeof chart.points[0]?.x === "number";
  const xDomain = chart.bins.length
    ? ([chart.bins[0]!.lower, chart.bins[chart.bins.length - 1]!.upper] as [
        number,
        number,
      ])
    : !sector && numeric && chart.type !== "bar" && chart.points.length
      ? numericDomain(chart.points.map((point) => point.x as number))
      : undefined;
  const yDomain = chart.bins.length
    ? numericDomain(
        chart.bins.map((bin) => bin.count),
        true,
      )
    : !sector && points.length
      ? numericDomain(
          points.map((point) => point.y),
          chart.type === "bar" || chart.type === "area",
        )
      : undefined;

  return {
    points,
    total,
    message,
    xDomain,
    yDomain,
  };
}
