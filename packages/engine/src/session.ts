import type {
  ControlState,
  Diagnostic,
  DocNode,
  Program,
  ResolvedNode,
  Result,
  Revision,
  SafeHtmlTag,
  Scalar,
  Session,
  TableValue,
  Value,
} from "@tinta/types";
import { attempt, Budget, fail, freeze, record } from "./common.js";
import { programs } from "./programs.js";
import {
  evaluate,
  format,
  type Environment,
  type RuntimeValue,
} from "./expression.js";
import { prepare } from "./charts.js";
import { inDomain } from "./grid.js";

function compare(a: Scalar, b: Scalar): number {
  if (typeof a === "string" && typeof b === "string") {
    const x = [...a],
      y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const delta = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      if (delta) return delta;
    }
    return x.length - y.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function revision(
  program: Program,
  state: ControlState,
  number: number,
): Revision {
  const bound = programs.get(program)!;
  const span = program.flow[0]?.span ??
    program.declarations[0]?.span ?? {
      uri: program.sourceUri,
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 0, line: 1, column: 1 },
    };
  const budget = new Budget(span, "evaluate", { limits: bound.limits });
  const values = record<Value>(),
    tables = record<TableValue>();
  const get = (name: string): RuntimeValue =>
    Object.hasOwn(values, name) ? values[name]! : tables[name]!;
  const env: Environment = { get, budget, metadata: program.metadata };

  for (const d of bound.order) {
    if (d.kind === "let") values[d.name] = bound.constants.get(d.name) as Value;
    else if (d.kind === "calc")
      values[d.name] = evaluate(d.expression, env) as Value;
    else if (d.kind === "data") tables[d.name] = d.table;
    else if (d.kind === "view") {
      const table = tables[d.source]!;
      const rows = table.rows.filter((row) => {
        budget.charge(d.span);
        return (
          !d.where ||
          evaluate(d.where, {
            ...env,
            row: new Map(table.columns.map((c, i) => [c.name, row.cells[i]!])),
          })
        );
      });
      if (d.sort) {
        const index = table.columns.findIndex((c) => c.name === d.sort);
        rows.sort((a, b) => {
          budget.charge(d.span);
          return (
            compare(a.cells[index]!, b.cells[index]!) * (d.descending ? -1 : 1)
          );
        });
      }
      tables[d.name] = { columns: table.columns, rows };
    } else values[d.name] = state[d.name]!;
  }

  let marks = 0;
  const text = (id: string, value: string): ResolvedNode => {
    budget.limit("textValueUnits", value.length);
    return { kind: "text", id, value };
  };
  const element = (
    id: string,
    tag: SafeHtmlTag,
    children: readonly ResolvedNode[],
    attributes: Readonly<Record<string, Scalar>> = {},
  ): ResolvedNode => ({
    kind: "element",
    id,
    tag,
    attributes,
    children,
  });
  function resolve(node: DocNode): ResolvedNode[] {
    const children = (): ResolvedNode[] =>
      "children" in node ? node.children.flatMap(resolve) : [];

    switch (node.kind) {
      case "text":
      case "raw-html":
        return [text(node.id, node.value)];
      case "interpolation":
        return [
          text(
            node.id,
            format(evaluate(node.expression, env) as Scalar, program.metadata),
          ),
        ];
      case "when":
        return evaluate(node.condition, env) ? children() : [];
      case "details":
        return [
          element(node.id, "details", [
            element(node.id, "summary", [text(node.id, node.summary)]),
            ...children(),
          ]),
        ];
      case "control":
        return [
          {
            kind: "control",
            id: node.id,
            definition: bound.controls.get(node.name)!,
            value: state[node.name]!,
          },
        ];
      case "chart": {
        const chart = prepare(
          node.chart,
          tables[node.chart.source]!,
          env,
          bound.controls,
        );
        marks += chart.points.length + chart.bins.length;
        budget.limit("documentChartMarks", marks, node.span);
        return [{ kind: "chart", id: node.id, chart }];
      }
      case "image":
        return [
          {
            kind: "image",
            id: node.id,
            destination: node.destination,
            alt: node.alt,
            ...(node.title !== undefined ? { title: node.title } : {}),
          },
        ];
      case "paragraph":
      case "emphasis":
      case "strong":
      case "delete":
      case "blockquote":
        return [
          element(
            node.id,
            {
              paragraph: "p",
              emphasis: "em",
              strong: "strong",
              delete: "del",
              blockquote: "blockquote",
            }[node.kind] as SafeHtmlTag,
            children(),
          ),
        ];
      case "heading":
        return [
          element(node.id, `h${node.level}`, children(), { id: node.anchor }),
        ];
      case "link": {
        const safe =
          /^(?:https?:|mailto:|#)/i.test(node.destination) &&
          ![...node.destination].some((char) => char.codePointAt(0)! <= 32);
        return [
          element(
            node.id,
            safe ? "a" : "span",
            children(),
            safe
              ? {
                  href: node.destination,
                  ...(node.title === undefined ? {} : { title: node.title }),
                }
              : {},
          ),
        ];
      }
      case "code": {
        const code = element(node.id, "code", [text(node.id, node.value)]);
        return [node.block ? element(node.id, "pre", [code]) : code];
      }
      case "break":
        return node.hard ? [element(node.id, "br", [])] : [text(node.id, "\n")];
      case "thematic-break":
        return [element(node.id, "hr", [])];
      case "list":
        return [
          element(
            node.id,
            node.ordered ? "ol" : "ul",
            node.items.map((item) =>
              element(item.id, "li", [
                ...(item.checked === undefined
                  ? []
                  : [
                      element(item.id, "input", [], {
                        type: "checkbox",
                        disabled: true,
                        checked: item.checked,
                      }),
                    ]),
                ...item.children.flatMap(resolve),
              ]),
            ),
            node.ordered ? { start: node.start } : {},
          ),
        ];
      case "markdown-table":
        return [
          element(node.id, "table", [
            element(node.id, "thead", [
              element(
                node.id,
                "tr",
                node.header.map((cell) =>
                  element(node.id, "th", cell.flatMap(resolve), {
                    scope: "col",
                  }),
                ),
              ),
            ]),
            element(
              node.id,
              "tbody",
              node.rows.map((row) =>
                element(
                  node.id,
                  "tr",
                  row.map((cell) =>
                    element(node.id, "td", cell.flatMap(resolve)),
                  ),
                ),
              ),
            ),
          ]),
        ];
      case "data-table": {
        const table = tables[node.source]!;

        return [
          element(node.id, "table", [
            element(node.id, "caption", [
              text(
                node.id,
                `${node.title} — ${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`,
              ),
            ]),
            element(node.id, "thead", [
              element(
                node.id,
                "tr",
                table.columns.map((c) =>
                  element(node.id, "th", [text(node.id, c.name)], {
                    scope: "col",
                  }),
                ),
              ),
            ]),
            element(
              node.id,
              "tbody",
              table.rows.map((row) =>
                element(
                  node.id,
                  "tr",
                  row.cells.map((cell) =>
                    element(node.id, "td", [
                      text(node.id, format(cell, program.metadata)),
                    ]),
                  ),
                ),
              ),
            ),
          ]),
          ...(table.rows.length
            ? []
            : [text(node.id, "No rows match the current choices.")]),
        ];
      }
    }
  }

  return freeze({
    number,
    state,
    values,
    tables,
    nodes: program.flow.flatMap(resolve),
    diagnostics: [],
  });
}

export function createSession(
  program: Program,
  options?: { readonly baseline?: ControlState },
): Result<Session> {
  const fallback = {
    uri: program.sourceUri,
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
  };

  return attempt(() => {
    const bound = programs.get(program);
    if (!bound) fail("E_PROTOCOL", fallback, "host");
    const baseline = record<Scalar>();

    for (const [name, control] of bound.controls)
      baseline[name] = control.initial;

    const validate = (update: ControlState): void => {
      for (const [name, value] of Object.entries(update)) {
        const control = bound.controls.get(name);
        if (!control) fail("E_STATE_NAME", fallback, "evaluate");
        if (!inDomain(control, value))
          fail("E_STATE_DOMAIN", control.span, "evaluate");
      }
    };
    if (options?.baseline) {
      validate(options.baseline);
      if (Object.keys(options.baseline).length !== bound.controls.size)
        fail("E_STATE_DOMAIN", fallback, "evaluate");
      Object.assign(baseline, options.baseline);
    }
    for (const name of Object.keys(baseline))
      if (Object.is(baseline[name], -0)) baseline[name] = 0;
    freeze(baseline);
    let current = revision(program, baseline, 0);
    let destroyed = false,
      notifying = false;
    const listeners = new Set<(revision: Revision) => void>();
    const setControls = (update: ControlState): Result<Revision> => {
      const diagnostics: Diagnostic[] = [];

      return attempt(() => {
        if (destroyed || notifying) fail("E_PROTOCOL", fallback, "host");
        validate(update);
        const candidate = Object.assign(
          record<Scalar>(),
          current.state,
          update,
        );

        for (const name of Object.keys(candidate))
          if (Object.is(candidate[name], -0)) candidate[name] = 0;
        if (
          Object.keys(candidate).every(
            (name) => candidate[name] === current.state[name],
          )
        )
          return current;

        const next = revision(program, candidate, current.number + 1);
        current = next;
        notifying = true;
        try {
          for (const listener of [...listeners]) {
            if (destroyed) break;
            try {
              listener(current);
            } catch {
              diagnostics.push({
                code: "E_INTERNAL",
                severity: "error",
                phase: "host",
                message: "A subscriber failed after the revision committed.",
                span: fallback,
              });
            }
          }
        } finally {
          notifying = false;
        }

        return current;
      }, diagnostics);
    };

    return {
      program,
      getRevision: () => current,
      setControls,
      setControl: (name, value) => setControls({ [name]: value }),
      reset: () => setControls(baseline),
      subscribe: (listener) => {
        if (!destroyed) listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      destroy: () => {
        destroyed = true;
        listeners.clear();
      },
    };
  });
}
