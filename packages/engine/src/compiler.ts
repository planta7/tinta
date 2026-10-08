import { parse, type SyntaxNode, type DirectiveSyntax } from "@tinta/syntax";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  ChartSpec,
  CompilerOptions,
  ControlDefinition,
  Declaration,
  DocNode,
  Expr,
  Metadata,
  Program,
  ProgramIR,
  Result,
  Scalar,
  Span,
  SourceInput,
} from "@tinta/types";
import { attempt, Budget, fail, freeze, label } from "./common.js";
import { grid, inDomain, units } from "./grid.js";
import { bind } from "./binding.js";
import { registry } from "./registry.js";

import { programs } from "./programs.js";
export { programs } from "./programs.js";

function literal(expr: Expr): Scalar {
  if (expr.kind === "literal") return expr.value;
  if (
    expr.kind === "unary" &&
    expr.operator !== "not" &&
    expr.operand.kind === "literal" &&
    typeof expr.operand.value === "number"
  )
    return (expr.operator === "-" ? -1 : 1) * expr.operand.value || 0;
  fail("E_PROPERTY_VALUE", expr.span);
}
function option(
  d: DirectiveSyntax,
  key: string,
  fallback: Scalar,
  node: SyntaxNode,
): Scalar {
  const expr = d.options[key];
  const value = expr ? literal(expr) : fallback;
  if (typeof value !== typeof fallback)
    fail("E_PROPERTY_VALUE", expr?.span ?? node.span);
  return value;
}
export function compile(
  input: SourceInput,
  options?: CompilerOptions,
): Result<Program> {
  const parsed = parse(input, options);
  if (!parsed.ok) return parsed;
  return attempt(
    () => {
      const { tree, source, bytes } = parsed.value;
      const budget = new Budget(tree.span, "bind", options);
      budget.charge(tree.span, parsed.value.compileOperations);
      const declarations: Declaration[] = [];
      const locations = new Map<string, Span>();
      const heading = tree.children.find((n) => n.kind === "heading");
      const plain = (node: SyntaxNode): string =>
        node.kind === "interpolation"
          ? ""
          : (node.value ?? node.children.map(plain).join(""));
      let metadata: Metadata = {
        version: "1.0",
        title: heading ? plain(heading) : "Untitled document",
        locale: "en-US",
        currency: "USD",
      };
      function convert(node: SyntaxNode): DocNode[] {
        budget.charge(node.span);
        const base = { id: node.id, span: node.span };
        const children = (): DocNode[] => node.children.flatMap(convert);
        const a = node.attributes ?? {};
        if (node.directive) {
          const d = node.directive,
            name = d.binding ?? "";
          const declaration = { ...base, name };
          for (const [key, expression] of Object.entries(d.options))
            locations.set(`${node.id}:option:${key}`, expression.span);
          d.columnSpans?.forEach((span, i) =>
            locations.set(`${node.id}:column:${i}`, span),
          );
          d.rows?.forEach((row, i) => {
            locations.set(`${node.id}:${i}`, row.span);
            row.cellSpans.forEach((span, j) =>
              locations.set(`${node.id}:${i}:cell:${j}`, span),
            );
          });
          const text = (key: string, fallback: string): string => {
            const value = option(d, key, fallback, node) as string;
            budget.limit(
              "labelCodePoints",
              [...value].length,
              d.options[key]?.span ?? node.span,
            );
            return value;
          };
          switch (d.name) {
            case "meta": {
              const version = option(d, "version", "1.0", node);
              if (version !== "1.0") fail("E_VERSION", d.options.version!.span);
              const locale = option(d, "locale", "en-US", node),
                currency = option(d, "currency", "USD", node);
              if (
                !(registry.locales as readonly Scalar[]).includes(locale) ||
                !(registry.currencies as readonly Scalar[]).includes(currency)
              )
                fail("E_META_VALUE", node.span);
              metadata = {
                version,
                title: text("title", metadata.title),
                locale: locale as Metadata["locale"],
                currency: currency as Metadata["currency"],
              };
              return [];
            }
            case "let":
            case "calc":
              declarations.push({
                ...declaration,
                kind: d.name,
                expression: d.expression!,
              });
              return [];
            case "data":
              declarations.push({
                ...declaration,
                kind: "data",
                table: {
                  columns: d.columns!,
                  rows: d.rows!.map((row, i) => ({
                    id: `${node.id}:${i}`,
                    cells: row.cells.map((value) =>
                      typeof value === "number" && value === 0 ? 0 : value,
                    ),
                  })),
                },
              });
              return [];
            case "view": {
              if (d.options.descending && !d.options.sort)
                fail("E_PROPERTY_DEPENDENCY", d.options.descending.span);
              declarations.push({
                ...declaration,
                kind: "view",
                source: d.source!,
                descending: option(d, "descending", false, node) as boolean,
                ...(d.options.where ? { where: d.options.where } : {}),
                ...(d.options.sort
                  ? { sort: option(d, "sort", "", node) as string }
                  : {}),
              });
              return [];
            }
            case "slider":
            case "toggle":
            case "choice": {
              const initial = literal(d.expression!);
              const controlBase = {
                ...declaration,
                label: text("label", label(name)),
              };
              let control: ControlDefinition;
              if (d.name === "slider") {
                const min = option(d, "min", 0, node) as number,
                  max = option(d, "max", 100, node) as number,
                  step = option(d, "step", 1, node) as number;
                const raw = (key: string, value: number): string => {
                  const e = d.options[key];
                  return e
                    ? source.slice(e.span.start.offset, e.span.end.offset)
                    : String(value);
                };
                control = {
                  ...controlBase,
                  kind: "slider",
                  initial: initial as number,
                  min,
                  max,
                  step,
                  grid: grid(
                    raw("min", min),
                    raw("max", max),
                    raw("step", step),
                    node.span,
                  ),
                };
                if (
                  units(
                    source.slice(
                      d.expression!.span.start.offset,
                      d.expression!.span.end.offset,
                    ),
                  ) === undefined
                )
                  fail("E_STATE_DOMAIN", node.span);
                budget.limit("sliderTicks", control.grid.ticks, node.span);
                budget.limit(
                  "sliderMagnitude",
                  Math.max(Math.abs(min), Math.abs(max)),
                  node.span,
                );
                const divisor =
                  10n ** BigInt(6 - budget.limits.sliderFractionalDigits!);
                for (const value of [
                  control.grid.minUnits,
                  control.grid.stepUnits,
                  String(units(raw("max", max))),
                  String(
                    units(
                      source.slice(
                        d.expression!.span.start.offset,
                        d.expression!.span.end.offset,
                      ),
                    ),
                  ),
                ]) {
                  if (BigInt(value) % divisor !== 0n)
                    fail("E_STATE_DOMAIN", node.span);
                }
              } else if (d.name === "toggle")
                control = {
                  ...controlBase,
                  kind: "toggle",
                  initial: initial as boolean,
                };
              else {
                const e = d.options.options;
                if (!e) fail("E_PROPERTY_REQUIRED", node.span);
                if (e.kind !== "list" || e.items.length === 0)
                  fail("E_PROPERTY_VALUE", e.span);
                budget.limit("choiceOptions", e.items.length, e.span);
                const values = e.items.map((item) => {
                  const value = literal(item);
                  if (typeof value !== "string" || !value.length)
                    fail("E_PROPERTY_VALUE", item.span);
                  budget.limit(
                    "choiceOptionCodePoints",
                    [...value].length,
                    item.span,
                  );
                  return value;
                });
                if (new Set(values).size !== values.length)
                  fail("E_PROPERTY_VALUE", e.span);
                control = {
                  ...controlBase,
                  kind: "choice",
                  initial: initial as string,
                  options: values,
                };
              }
              if (!inDomain(control, initial))
                fail("E_STATE_DOMAIN", d.expression!.span);
              declarations.push(control);
              return [{ ...base, kind: "control", name }];
            }
            case "when":
              return [
                {
                  ...base,
                  kind: "when",
                  condition: d.expression!,
                  children: children(),
                },
              ];
            case "details":
              budget.limit(
                "labelCodePoints",
                [...(d.summary ?? "More information")].length,
                node.span,
              );
              return [
                {
                  ...base,
                  kind: "details",
                  summary: d.summary ?? "More information",
                  children: children(),
                },
              ];
            case "table":
              return [
                {
                  ...base,
                  kind: "data-table",
                  source: d.source!,
                  title: text("title", label(d.source!)),
                },
              ];
            case "chart": {
              const kind = d.chartType!;
              if (!d.options.x || (kind !== "histogram" && !d.options.y))
                fail("E_PROPERTY_REQUIRED", node.span);
              if (
                (kind === "histogram" && (d.options.y || d.options.select)) ||
                (kind !== "histogram" && d.options.bins)
              )
                fail("E_PROPERTY_VALUE", node.span);
              const y = d.options.y;
              let series: ChartSpec["y"];
              if (y?.kind === "literal" && typeof y.value === "string")
                series = { kind: "columns", columns: [y.value] };
              else if (y?.kind === "list") {
                const columns = y.items.map((e) => {
                  if (e.kind !== "literal" || typeof e.value !== "string")
                    fail("E_CHART_SERIES", e.span);
                  return e.value;
                });
                if (
                  !columns.length ||
                  columns.length > 6 ||
                  new Set(columns).size !== columns.length
                )
                  fail("E_CHART_SERIES", y.span);
                series = { kind: "columns", columns };
              } else if (y) series = { kind: "expression", expression: y };
              if (
                (kind === "pie" || kind === "donut") &&
                series?.kind === "columns" &&
                series.columns.length !== 1
              )
                fail("E_CHART_SERIES", y!.span);
              const select = d.options.select;
              if (select && select.kind !== "name")
                fail("E_SELECTION_TARGET", select.span);
              const bins = option(d, "bins", 8, node) as number;
              if (!Number.isInteger(bins) || bins < 2 || bins > 30)
                fail("E_PROPERTY_VALUE", node.span);
              if (kind === "histogram")
                budget.limit("histogramBinsMax", bins, node.span);
              const typeLabel = {
                line: "Line chart",
                area: "Area chart",
                bar: "Bar chart",
                scatter: "Scatter plot",
                pie: "Pie chart",
                donut: "Donut chart",
                histogram: "Histogram",
              }[kind];
              const x = option(d, "x", "", node) as string;
              const chart: ChartSpec = {
                ...base,
                kind,
                source: d.source!,
                x,
                title: text("title", `${typeLabel} — ${label(d.source!)}`),
                xLabel: text("xLabel", label(x)),
                yLabel: text(
                  "yLabel",
                  kind === "histogram"
                    ? "Frequency"
                    : series?.kind === "columns" && series.columns.length === 1
                      ? label(series.columns[0]!)
                      : "Value",
                ),
                ...(series ? { y: series } : {}),
                ...(select?.kind === "name" ? { select: select.name } : {}),
                ...(kind === "histogram" ? { bins } : {}),
              };
              return [{ ...base, kind: "chart", chart }];
            }
            case "end":
              fail("E_BLOCK_END", node.span);
          }
        }
        switch (node.kind) {
          case "root":
            return children();
          case "definition":
            return [];
          case "text":
            return [{ ...base, kind: "text", value: node.value! }];
          case "interpolation":
            return [
              { ...base, kind: "interpolation", expression: node.expression! },
            ];
          case "html":
            return /^(?:\s*<!--(?:(?!-->)[\s\S])*-->)+\s*$/.test(node.value!)
              ? []
              : [{ ...base, kind: "raw-html", value: node.value! }];
          case "paragraph":
          case "emphasis":
          case "strong":
          case "delete":
          case "blockquote":
            return [{ ...base, kind: node.kind, children: children() }];
          case "heading":
            return [
              {
                ...base,
                kind: "heading",
                level: a.level as 1 | 2 | 3 | 4 | 5 | 6,
                anchor: a.anchor as string,
                children: children(),
              },
            ];
          case "link":
          case "linkReference":
            return [
              {
                ...base,
                kind: "link",
                destination: a.destination as string,
                ...(typeof a.title === "string" ? { title: a.title } : {}),
                children: children(),
              },
            ];
          case "image":
          case "imageReference":
            return [
              {
                ...base,
                kind: "image",
                destination: a.destination as string,
                alt: a.alt as string,
                ...(typeof a.title === "string" ? { title: a.title } : {}),
              },
            ];
          case "code":
          case "inlineCode":
            return [
              {
                ...base,
                kind: "code",
                block: node.kind === "code",
                value: node.value!,
                ...(typeof a.language === "string"
                  ? { language: a.language }
                  : {}),
              },
            ];
          case "break":
            return [{ ...base, kind: "break", hard: true }];
          case "thematicBreak":
            return [{ ...base, kind: "thematic-break" }];
          case "list":
            return [
              {
                ...base,
                kind: "list",
                ordered: a.ordered as boolean,
                start: a.start as number,
                tight: !a.spread,
                items: node.children.map((item) => ({
                  id: item.id,
                  span: item.span,
                  ...(typeof item.attributes?.checked === "boolean"
                    ? { checked: item.attributes.checked }
                    : {}),
                  children: item.children.flatMap(convert),
                })),
              },
            ];
          case "table":
            return [
              {
                ...base,
                kind: "markdown-table",
                align: (
                  a.align as readonly ("left" | "right" | "center" | null)[]
                ).map((v) => v ?? "none"),
                header: node.children[0]!.children.map((cell) =>
                  cell.children.flatMap(convert),
                ),
                rows: node.children
                  .slice(1)
                  .map((row) =>
                    row.children.map((cell) => cell.children.flatMap(convert)),
                  ),
              },
            ];
          default:
            fail("E_INTERNAL", node.span);
        }
      }
      const flow = tree.children.flatMap(convert);
      budget.limit("labelCodePoints", [...metadata.title].length);
      const ir: ProgramIR = {
        abi: "tinta-ir-1",
        sourceVersion: "1.0",
        contractRevision: "1.0-draft.2",
        profile: input.profile,
        source,
        sourceUri: input.uri,
        sourceSha256: bytesToHex(sha256(bytes)),
        metadata,
        declarations,
        flow,
      };
      const bound = bind(ir, budget, locations);
      const program = freeze(ir) as Program;
      programs.set(program, bound);
      return program;
    },
    parsed.diagnostics,
    options?.limits?.diagnostics,
  );
}
