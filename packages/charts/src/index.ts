import type { ChartPoint, PreparedChart } from "@tinta-lang/types";
import { chartPresentation } from "@tinta-lang/engine/chart-presentation";
import { ticks } from "d3-array";
import { scaleBand, scaleLinear, scalePoint } from "d3-scale";
import {
  arc,
  area,
  curveLinear,
  line,
  pie,
  symbol,
  symbolCircle,
  symbolSquare,
  symbolTriangle,
  symbolDiamond,
  symbolCross,
  symbolStar,
} from "d3-shape";

export interface SceneNode {
  readonly tag: "path" | "line" | "rect" | "circle" | "text";
  readonly attributes: Readonly<Record<string, string | number>>;
  readonly text?: string;
  readonly pointId?: string;
}

export interface ChartScene {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly SceneNode[];
  readonly message: string;
  readonly total: number;
}

export const palette = [
  "#0072B2",
  "#D55E00",
  "#009E73",
  "#CC79A7",
  "#8C6D00",
  "#6F4E7C",
] as const;
const dashes = ["none", "6 3", "2 3", "8 3 2 3", "1 2", "10 3"];
const shapes = [
  symbolCircle,
  symbolSquare,
  symbolTriangle,
  symbolDiamond,
  symbolCross,
  symbolStar,
];

export function coordinate(value: number): string {
  if (!Number.isFinite(value)) throw new Error("E_CHART_DOMAIN");
  return String(Number(value.toFixed(3)));
}

export function tickLabel(value: string | number): string {
  const characters = [...String(value)];
  return characters.length > 14
    ? characters.slice(0, 14).join("") + "…"
    : characters.join("");
}

/** Produces only renderer-owned primitives; accepts no author SVG or style. */
export function chartScene(
  chart: PreparedChart,
  contentWidth: number,
  hidden: ReadonlySet<string> = new Set(),
  selected?: string | number,
): ChartScene {
  if (!Number.isFinite(contentWidth)) throw new Error("E_CHART_DOMAIN");
  const width = Math.max(280, Math.min(800, Math.round(contentWidth)));
  const height = Math.round(Math.max(240, Math.min(400, width * 0.55)));
  const view = chartPresentation(chart, hidden);
  const nodes: SceneNode[] = [];
  const add = (
    tag: SceneNode["tag"],
    attributes: Record<string, string | number>,
    text?: string,
    pointId?: string,
  ) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "number") attributes[key] = coordinate(value);
      else if (
        (key === "d" || key === "transform") &&
        /NaN|Infinity/.test(value)
      )
        throw new Error("E_CHART_DOMAIN");
    }
    nodes.push({
      tag,
      attributes,
      ...(text === undefined ? {} : { text }),
      ...(pointId ? { pointId } : {}),
    });
  };
  const finish = () => ({
    width,
    height,
    nodes,
    message: view.message,
    total: view.total,
  });
  const color = (index: number) => palette[index % palette.length]!;
  const sector = chart.type === "pie" || chart.type === "donut";
  if (sector) {
    if (view.total > 0) {
      const radius = Math.min(width, height) / 2 - 20;
      // Normalizing before D3 avoids overflow in its angle multiplier for tiny totals.
      const slices = pie<ChartPoint>()
        .sort(null)
        .padAngle(0)
        .value((point) => point.y / view.total)(view.points);
      const path = arc<(typeof slices)[number]>()
        .innerRadius(chart.type === "donut" ? radius * 0.6 : 0)
        .outerRadius(radius)
        .digits(3);

      for (const slice of slices) {
        if (slice.data.y === 0) continue;
        const index = chart.points.findIndex(
          (point) => point.id === slice.data.id,
        );
        add(
          "path",
          {
            d: path(slice) ?? "",
            transform: `translate(${coordinate(width / 2)},${coordinate(height / 2)})`,
            fill: color(index),
            stroke: selected === slice.data.x ? "#1f2328" : "#ffffff",
            "stroke-width": selected === slice.data.x ? 3 : 1,
          },
          undefined,
          slice.data.id,
        );
      }
    }
    if (chart.type === "donut") {
      add(
        "text",
        {
          x: width / 2,
          y: height / 2,
          "text-anchor": "middle",
          fill: "#1f2328",
        },
        `Visible total: ${view.total}`,
      );
    }

    return finish();
  }
  if (!view.yDomain) return finish();
  const left = 64,
    right = width - 20,
    top = 20,
    bottom = height - 48;
  const y = scaleLinear().domain(view.yDomain).range([bottom, top]);
  const categories = [...new Set(chart.points.map((point) => String(point.x)))];
  const band = scaleBand()
    .domain(categories)
    .range([left, right])
    .paddingInner(0.2)
    .paddingOuter(0.1);
  const pointScale = scalePoint()
    .domain(categories)
    .range([left, right])
    .padding(0.5);
  const numeric = view.xDomain
    ? scaleLinear().domain(view.xDomain).range([left, right])
    : undefined;
  const x = (point: ChartPoint) =>
    chart.type === "bar"
      ? band(String(point.x))!
      : numeric
        ? numeric(point.x as number)
        : pointScale(String(point.x))!;
  add("line", {
    x1: left,
    x2: left,
    y1: top,
    y2: bottom,
    stroke: "#59636e",
  });
  add("line", {
    x1: left,
    x2: right,
    y1: bottom,
    y2: bottom,
    stroke: "#59636e",
  });
  for (const value of ticks(view.yDomain[0], view.yDomain[1], 5)) {
    add(
      "text",
      {
        x: left - 8,
        y: y(value),
        "text-anchor": "end",
        fill: "#1f2328",
      },
      tickLabel(value),
    );
  }
  if (numeric && chart.type !== "bar") {
    for (const value of ticks(view.xDomain![0], view.xDomain![1], 5)) {
      add(
        "text",
        {
          x: numeric(value),
          y: bottom + 20,
          "text-anchor": "middle",
          fill: "#1f2328",
        },
        tickLabel(value),
      );
    }
  } else {
    const stride = Math.ceil(
      categories.length / Math.max(2, Math.floor((right - left) / 70)),
    );
    categories.forEach((value, i) => {
      if (i % stride === 0 || i === categories.length - 1) {
        add(
          "text",
          {
            x:
              chart.type === "bar"
                ? band(value)! + band.bandwidth() / 2
                : pointScale(value)!,
            y: bottom + 20,
            "text-anchor": "middle",
            fill: "#1f2328",
          },
          tickLabel(value),
        );
      }
    });
  }
  add(
    "text",
    {
      x: (left + right) / 2,
      y: height - 4,
      "text-anchor": "middle",
      fill: "#1f2328",
    },
    chart.xLabel,
  );
  add("text", { x: left, y: 12, fill: "#1f2328" }, chart.yLabel);
  if (chart.type === "histogram") {
    for (const bin of chart.bins) {
      add(
        "rect",
        {
          x: numeric!(bin.lower),
          y: y(bin.count),
          width: Math.max(1, numeric!(bin.upper) - numeric!(bin.lower)),
          height: Math.max(1, y(0) - y(bin.count)),
          fill: color(0),
          stroke: "#1f2328",
          "stroke-width": 0.5,
        },
        undefined,
        bin.id,
      );
    }
    return finish();
  }

  const visibleSeries = chart.series
    .map((series, index) => ({ ...series, index }))
    .filter((series) => !hidden.has(series.id));
  const sub = scaleBand<number>()
    .domain(visibleSeries.map((series) => series.index))
    .range([0, band.bandwidth()])
    .paddingInner(0.1);

  for (const series of visibleSeries) {
    const points = view.points.filter(
      (point) => point.seriesIndex === series.index,
    );
    if (chart.type === "line" || chart.type === "area") {
      if (chart.type === "area") {
        const shape = area<ChartPoint>()
          .x(x)
          .y0(y(0))
          .y1((point) => y(point.y))
          .curve(curveLinear)
          .digits(3);
        add("path", {
          d: shape(points) ?? "",
          fill: color(series.index),
          "fill-opacity": 0.15,
        });
      }

      const shape = line<ChartPoint>()
        .x(x)
        .y((point) => y(point.y))
        .curve(curveLinear)
        .digits(3);
      add("path", {
        d: shape(points) ?? "",
        fill: "none",
        stroke: color(series.index),
        "stroke-width": 2,
        "stroke-dasharray": dashes[series.index]!,
      });
    }
  }
  for (const point of view.points) {
    const selectedPoint = selected === point.x;
    const common = {
      fill: color(point.seriesIndex),
      stroke: "#1f2328",
      "stroke-width": selectedPoint ? 3 : 0.5,
    };
    if (chart.type === "bar") {
      add(
        "rect",
        {
          ...common,
          x: x(point) + sub(point.seriesIndex)!,
          y: Math.min(y(0), y(point.y)),
          width: Math.max(1, sub.bandwidth()),
          height: Math.max(1, Math.abs(y(point.y) - y(0))),
        },
        undefined,
        point.id,
      );
    } else {
      if (chart.type === "scatter") {
        const path = symbol()
          .type(shapes[point.seriesIndex]!)
          .size(Math.PI * 16)
          .digits(3)();
        add("path", {
          ...common,
          d: path ?? "",
          transform: `translate(${coordinate(x(point))},${coordinate(y(point.y))})`,
        });
      } else
        add("circle", {
          ...common,
          cx: x(point),
          cy: y(point.y),
          r: 4,
        });
      add(
        "circle",
        {
          cx: x(point),
          cy: y(point.y),
          r: 12,
          fill: "transparent",
        },
        undefined,
        point.id,
      );
    }
  }

  return finish();
}
