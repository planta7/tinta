import type {
  ChartPoint,
  ControlState,
  HistogramBin,
  PreparedChart,
} from "@tinta-lang/types";
import {
  chartPresentation,
  legendKey,
} from "@tinta-lang/engine/chart-presentation";
import { chartScene, coordinate } from "@tinta-lang/charts";

type Datum = ChartPoint | HistogramBin;

export interface ChartView {
  readonly root: HTMLElement;
  update(chart: PreparedChart, state: ControlState): void;
  reset(): void;
  destroy(): void;
}

export function createChartView(
  doc: Document,
  id: string,
  initial: PreparedChart,
  select: (name: string, value: string | number) => boolean,
): ChartView {
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = element("figure");
  root.dataset.tintaChart = initial.id;
  const caption = element("figcaption");
  const description = element("p");
  const scroll = element("div");
  scroll.className = "tinta-chart-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", `${initial.title} — figure ${id}`);
  const legend = element("div");
  legend.className = "tinta-chart-legend";
  const explorer = element("div");
  const label = element("label", "Inspect data point");
  const range = element("input");
  range.type = "range";
  range.min = "1";
  range.step = "1";
  range.id = id + "-inspector";
  label.htmlFor = range.id;
  const inspection = element("p");
  const action = element("button");
  action.type = "button";
  const output = element("output");
  output.setAttribute("aria-live", "polite");
  output.setAttribute("aria-atomic", "true");
  output.className = "tinta-chart-announcement";
  explorer.append(label, range, inspection, action, output);
  const details = element("details");
  const summary = element("summary", "Show data");
  const tableScroll = element("div");
  tableScroll.className = "tinta-scroll";
  tableScroll.tabIndex = 0;
  tableScroll.setAttribute("role", "region");
  tableScroll.setAttribute(
    "aria-label",
    `${initial.title} — figure data ${id}`,
  );
  details.append(summary, tableScroll);
  root.append(caption, description, scroll, legend, explorer, details);
  let chart = initial;
  let state: ControlState = {};
  let visible: readonly Datum[] = [];
  let index = 0;
  let pinned = false;
  let pointerInspection = false;
  let hidden = new Set<string>();
  let width = 720;
  let histogramDomain = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let resizeFrame: number | undefined;
  const listeners: Array<() => void> = [];
  const buttons = new Map<string, HTMLButtonElement>();
  const tableButtons = new Map<string, HTMLButtonElement>();
  function listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): void {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  }
  function announce(text: string): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!destroyed) output.value = text;
    }, 150);
  }
  function datumText(datum: Datum): string {
    if ("count" in datum)
      return (
        `${chart.xLabel}: [${datum.lower}, ${datum.upper}` +
        `${datum.upperInclusive ? "]" : ")"}; Count: ${datum.count}`
      );
    const series = chart.series[datum.seriesIndex]!.label;
    let text = `${chart.xLabel}: ${datum.x}; ${series}: ${datum.y}`;
    if (chart.type === "pie" || chart.type === "donut") {
      const total = chartPresentation(chart, hidden).total;
      text += `; ${total ? `${(datum.y / total) * 100}%` : "Not applicable"}`;
    }
    return text;
  }
  function inspect(deliberate = false): void {
    range.value = String(index + 1);
    const datum = visible[index];
    const text = datum
      ? `${datumText(datum)}; ${index + 1} of ${visible.length}`
      : description.textContent!;
    range.setAttribute("aria-valuetext", text);
    const selected =
      datum && "x" in datum && chart.select && state[chart.select] === datum.x;
    inspection.textContent = `${text}${pinned ? "; Pinned" : ""}${selected ? "; Selected" : ""}`;
    if (deliberate) announce(inspection.textContent);
  }
  function commit(datum: Datum | undefined): void {
    if (!datum) return;
    const datumId = datum.id;
    if (chart.select && "x" in datum && !select(chart.select, datum.x)) return;
    const nextIndex = visible.findIndex((item) => item.id === datumId);
    if (nextIndex >= 0) index = nextIndex;
    pinned = visible.length > 0;
    inspect(true);
  }
  function draw(): void {
    if (destroyed) return;
    const selected = chart.select ? state[chart.select] : undefined;
    const scene = chartScene(
      chart,
      width,
      hidden,
      typeof selected === "boolean" ? undefined : selected,
    );
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(scene.width));
    svg.setAttribute("height", String(scene.height));
    svg.setAttribute("viewBox", `0 0 ${scene.width} ${scene.height}`);
    svg.setAttribute("aria-hidden", "true");
    const pointById = new Map(chart.points.map((point) => [point.id, point]));

    for (const node of scene.nodes) {
      const child = doc.createElementNS(svg.namespaceURI, node.tag);
      for (const [name, value] of Object.entries(node.attributes)) {
        child.setAttribute(
          name,
          typeof value === "number" ? coordinate(value) : value,
        );
      }
      if (node.text !== undefined) child.textContent = node.text;
      if (node.pointId) {
        child.setAttribute("data-point-id", node.pointId);
        const datum = pointById.get(node.pointId);
        if (datum && selected === datum.x)
          child.setAttribute("data-selected", "true");
      }
      svg.append(child);
    }
    scroll.replaceChildren(svg);
    const outside =
      chart.select && !chart.points.some((point) => point.x === selected)
        ? " The selected value is not in this figure's current data."
        : "";
    const total =
      chart.type === "pie" || chart.type === "donut"
        ? ` Visible total: ${scene.total}.`
        : "";
    description.textContent =
      (scene.message ||
        `${chart.type} chart. Explore values below or show the complete data table.`) +
      `${total}${outside}`;
  }
  function rebuildTable(): void {
    const focused = tableScroll.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)
      : null;
    const table = element("table");
    table.append(
      element(
        "caption",
        `${chart.title} — ${chart.table.rows.length} source rows; ` +
          `all chart data, including hidden series and categories`,
      ),
    );
    const head = element("thead");
    const heading = element("tr");
    const names =
      chart.type === "histogram"
        ? ["Interval", "Count", "Visibility"]
        : [
            chart.xLabel,
            ...chart.series.map((series) => series.label),
            "Visibility",
            ...(chart.select ? ["Selection"] : []),
          ];

    for (const name of names) {
      const th = element("th", name);
      th.scope = "col";
      heading.append(th);
    }
    head.append(heading);
    table.append(head);
    const body = element("tbody");
    if (chart.type === "histogram") {
      for (const bin of chart.bins) {
        const row = element("tr");
        row.append(
          element(
            "td",
            `[${bin.lower}, ${bin.upper}${bin.upperInclusive ? "]" : ")"}`,
          ),
          element("td", String(bin.count)),
          element("td", "Visible"),
        );
        body.append(row);
      }
    } else {
      for (let i = 0; i < chart.points.length; i += chart.series.length) {
        const point = chart.points[i]!;
        const row = element("tr");
        row.append(element("td", String(point.x)));
        const visibility: string[] = [];

        for (let j = 0; j < chart.series.length; j++) {
          const datum = chart.points[i + j]!;
          row.append(element("td", String(datum.y)));
          visibility.push(
            `${chart.series[j]!.label}: ${hidden.has(legendKey(chart, i + j)) ? "Hidden" : "Visible"}`,
          );
        }
        row.append(element("td", visibility.join("; ")));
        if (chart.select) {
          const cell = element("td");
          let button = tableButtons.get(point.rowId);
          if (!button) {
            button = element("button");
            button.type = "button";
            tableButtons.set(point.rowId, button);
          }
          button.textContent = `Use ${point.x}`;
          button.dataset.pointId = point.id;
          cell.append(button);
          row.append(cell);
        }
        body.append(row);
      }
    }
    table.append(body);
    tableScroll.replaceChildren(table);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
  function availability(
    field: HTMLInputElement | HTMLButtonElement,
    disabled: boolean,
  ): void {
    field.setAttribute("aria-disabled", String(disabled));
    // Native disabling blurs an active element in some browsers. Retain it
    // with disabled semantics until focus leaves, then apply native disabling.
    field.disabled = disabled && doc.activeElement !== field;
  }
  function refresh(): void {
    const oldId = visible[index]?.id;
    const view = chartPresentation(chart, hidden);
    visible = chart.type === "histogram" ? chart.bins : view.points;
    const nextIndex = visible.findIndex((datum) => datum.id === oldId);
    index =
      nextIndex >= 0
        ? nextIndex
        : Math.max(0, Math.min(index, visible.length - 1));
    if (!visible.length) pinned = false;
    range.max = String(Math.max(1, visible.length));
    availability(range, visible.length <= 1);
    availability(action, visible.length === 0);
    action.textContent = chart.select
      ? "Use inspected value"
      : "Pin inspection";
    caption.textContent = chart.title;
    const sector = chart.type === "pie" || chart.type === "donut";
    const entries = sector
      ? chart.points.map((point, i) => ({
          key: legendKey(chart, i),
          label: `${point.x}: ${point.y}`,
        }))
      : chart.series.length > 1
        ? chart.series.map((series) => ({
            key: series.id,
            label: series.label,
          }))
        : [];
    const active = new Set(entries.map((entry) => entry.key));

    for (const [key, button] of buttons) if (!active.has(key)) button.remove();
    let legendCursor = legend.firstChild;

    for (const [entryIndex, entry] of entries.entries()) {
      let button = buttons.get(entry.key);
      if (!button) {
        button = element("button");
        button.type = "button";
        button.dataset.legendKey = entry.key;
        buttons.set(entry.key, button);
      }
      const swatch = element(
        "span",
        ["●", "■", "▲", "◆", "+", "★"][entryIndex % 6],
      );
      swatch.className = `tinta-chart-key tinta-series-${entryIndex % 6}`;
      swatch.setAttribute("aria-hidden", "true");
      button.replaceChildren(swatch, doc.createTextNode(entry.label));
      button.setAttribute("aria-pressed", String(!hidden.has(entry.key)));
      if (button !== legendCursor) legend.insertBefore(button, legendCursor);
      legendCursor = button.nextSibling;
    }
    draw();
    rebuildTable();
    inspect();
    if (oldId && !visible.length) announce(description.textContent!);
  }
  listen(range, "input", () => {
    if (visible.length <= 1) {
      range.value = "1";
      return;
    }
    index = Number(range.value) - 1;
    pointerInspection = false;
    inspect(true);
  });
  listen(explorer, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Escape") {
      pinned = false;
      inspect(true);
    } else if (event.target === range && visible.length <= 1 && key !== "Tab") {
      event.preventDefault();
    } else if (
      event.target === range &&
      (key === "PageUp" || key === "PageDown")
    ) {
      event.preventDefault();
      index = Math.max(
        0,
        Math.min(visible.length - 1, index + (key === "PageUp" ? 10 : -10)),
      );
      inspect(true);
    }
  });
  listen(action, "click", () => {
    action.focus({ preventScroll: true });
    commit(visible[index]);
  });
  listen(range, "blur", () => {
    range.disabled = visible.length <= 1;
  });
  listen(action, "blur", () => {
    action.disabled = visible.length === 0;
  });
  listen(legend, "click", (event) => {
    const key = (event.target as HTMLElement).closest("button")?.dataset
      .legendKey;
    if (key === undefined) return;
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    refresh();
    announce(description.textContent!);
  });
  listen(tableScroll, "click", (event) => {
    const id = (event.target as HTMLElement).closest("button")?.dataset.pointId;
    if (id) commit(chart.points.find((point) => point.id === id));
  });
  function pointer(event: Event, click: boolean): void {
    if (!click && (pinned || explorer.contains(doc.activeElement))) return;
    const id = (event.target as Element)
      .closest("[data-point-id]")
      ?.getAttribute("data-point-id");
    const found = visible.findIndex((datum) => datum.id === id);
    if (found < 0) return;
    index = found;
    pointerInspection = true;
    if (click) commit(visible[index]);
    else inspect();
  }
  listen(scroll, "pointermove", (event) => pointer(event, false));
  listen(scroll, "click", (event) => pointer(event, true));
  listen(scroll, "pointerleave", () => {
    if (!pinned && pointerInspection && !explorer.contains(doc.activeElement)) {
      pointerInspection = false;
      inspection.textContent = "";
    }
  });
  const observer = new ResizeObserver((entries) => {
    if (destroyed) return;
    const next = entries[0]?.contentRect.width;
    if (next && Math.round(next) !== width) {
      width = Math.round(next);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (!destroyed) draw();
      });
    }
  });
  observer.observe(root);

  return {
    root,
    update(next, nextState) {
      const domain = JSON.stringify(
        next.bins.map((bin) => [bin.lower, bin.upper]),
      );
      if (next.type === "histogram" && histogramDomain !== domain) {
        index = 0;
        pinned = false;
        visible = [];
      }
      histogramDomain = domain;
      chart = next;
      state = nextState;
      refresh();
    },
    reset() {
      hidden = new Set();
      pinned = false;
      index = 0;
      visible = [];
      details.open = false;
      refresh();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of listeners) remove();
      root.remove();
    },
  };
}
