import type {
  Column,
  ControlDefinition,
  Declaration,
  Diagnostic,
  DocNode,
  Expr,
  ProgramIR,
  Span,
} from "@tinta/types";
import { Budget, Failure, fail } from "./common.js";
import { evaluate, infer, type RuntimeValue, type Type } from "./expression.js";

export interface Bound {
  readonly compileOperations: number;
  readonly locations: ReadonlyMap<string, Span>;
  readonly order: readonly Declaration[];
  readonly controls: ReadonlyMap<string, ControlDefinition>;
  readonly constants: ReadonlyMap<string, RuntimeValue>;
  readonly limits: Readonly<Record<string, number>>;
}
export function walkFlow(
  nodes: readonly DocNode[],
  visit: (node: DocNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if ("children" in node) walkFlow(node.children, visit);
    if (node.kind === "list")
      node.items.forEach((item) => walkFlow(item.children, visit));
    if (node.kind === "markdown-table")
      [...node.header, ...node.rows.flat()].forEach((cell) =>
        walkFlow(cell, visit),
      );
  }
}
export function references(expr: Expr): Expr[] {
  if (expr.kind === "name") return [expr];
  if (expr.kind === "binary")
    return [...references(expr.left), ...references(expr.right)];
  if (expr.kind === "unary") return references(expr.operand);
  if (expr.kind === "call") return expr.arguments.flatMap(references);
  if (expr.kind === "list") return expr.items.flatMap(references);
  return [];
}
export function bind(
  ir: ProgramIR,
  budget: Budget,
  locations: ReadonlyMap<string, Span>,
): Bound {
  const symbols = new Map<string, Declaration>();
  const controls = new Map<string, ControlDefinition>();
  const order: Declaration[] = [];
  const types = new Map<string, Type>();
  const diagnostics: Diagnostic[] = [];
  const nameSpan = (d: Declaration): Span => {
    const offset = ir.source
      .slice(d.span.start.offset, d.span.end.offset)
      .indexOf(d.name, d.kind.length + 1);
    const start = {
      ...d.span.start,
      offset: d.span.start.offset + offset,
      column: d.span.start.column + offset,
    };
    return {
      uri: d.span.uri,
      start,
      end: {
        ...start,
        offset: start.offset + d.name.length,
        column: start.column + d.name.length,
      },
    };
  };
  const report = (
    code: string,
    span: Span,
    related: Diagnostic["related"] = [],
  ): void => {
    diagnostics.push({
      code,
      severity: "error",
      phase: "bind",
      message:
        code === "E_CYCLE"
          ? "A dependency cycle prevents evaluation."
          : code === "E_NAME_DUPLICATE"
            ? "A name is declared more than once."
            : "A global reference cannot be resolved.",
      span,
      related,
    });
  };
  const finish = (): void => {
    if (!diagnostics.length) return;
    diagnostics.sort(
      (a, b) =>
        a.span.start.offset - b.span.start.offset ||
        a.code.localeCompare(b.code, "en"),
    );
    const maximum = budget.limits.diagnostics!;
    if (diagnostics.length > maximum) {
      const observed = diagnostics.length;
      diagnostics.splice(maximum - 1);
      diagnostics.push({
        code: "E_LIMIT",
        severity: "error",
        phase: "bind",
        message: "The diagnostic limit was exceeded.",
        span: budget.span,
        details: { limitName: "diagnostics", observed, maximum },
      });
    }
    throw new Failure(diagnostics);
  };
  budget.limit("declarations", ir.declarations.length);
  for (const d of ir.declarations) {
    const previous = symbols.get(d.name);
    if (previous) {
      report("E_NAME_DUPLICATE", nameSpan(d), [
        { message: "First declaration.", span: nameSpan(previous) },
      ]);
      continue;
    }
    symbols.set(d.name, d);
    if (d.kind === "slider" || d.kind === "choice" || d.kind === "toggle")
      controls.set(d.name, d);
  }
  budget.limit("controls", controls.size);
  budget.limit(
    "tableCount",
    ir.declarations.filter((d) => d.kind === "data" || d.kind === "view")
      .length,
  );
  const graph = new Map<string, string[]>();
  for (const d of symbols.values()) {
    const refs: { name: string; span: Span }[] = [];
    if (d.kind === "view") refs.push({ name: d.source, span: d.span });
    const expr =
      "expression" in d
        ? d.expression
        : d.kind === "view"
          ? d.where
          : undefined;
    if (expr)
      for (const ref of references(expr))
        if (ref.kind === "name") refs.push(ref);
    const edges: string[] = [];
    for (const ref of refs) {
      budget.charge(ref.span);
      if (!symbols.has(ref.name)) report("E_NAME_UNKNOWN", ref.span);
      else edges.push(ref.name);
    }
    graph.set(d.name, edges);
  }
  // Tarjan's stack identifies every component, including inactive branches.
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    onStack = new Set<string>();
  function component(name: string): void {
    const index = indices.size;
    indices.set(name, index);
    low.set(name, index);
    stack.push(name);
    onStack.add(name);
    for (const edge of graph.get(name)!) {
      if (!indices.has(edge)) {
        component(edge);
        low.set(name, Math.min(low.get(name)!, low.get(edge)!));
      } else if (onStack.has(edge))
        low.set(name, Math.min(low.get(name)!, indices.get(edge)!));
    }
    if (low.get(name) !== index) return;
    const members: Declaration[] = [];
    let popped: string;
    do {
      popped = stack.pop()!;
      onStack.delete(popped);
      members.push(symbols.get(popped)!);
    } while (popped !== name);
    if (members.length > 1 || graph.get(name)!.includes(name)) {
      members.sort((a, b) => a.span.start.offset - b.span.start.offset);
      report(
        "E_CYCLE",
        nameSpan(members[0]!),
        members.map((d) => ({
          message: "Participating declaration.",
          span: nameSpan(d),
        })),
      );
    }
  }
  for (const name of symbols.keys()) if (!indices.has(name)) component(name);
  finish();
  function declaration(name: string, span: Span): Declaration {
    budget.charge(span);
    const d = symbols.get(name);
    if (!d) fail("E_NAME_UNKNOWN", span, "bind");
    return d;
  }
  function visit(d: Declaration): void {
    if (types.has(d.name)) return;

    const deps: { name: string; span: Span }[] = [];
    if (d.kind === "view") deps.push({ name: d.source, span: d.span });
    const expr =
      "expression" in d
        ? d.expression
        : d.kind === "view"
          ? d.where
          : undefined;
    if (expr)
      for (const ref of references(expr))
        if (ref.kind === "name") deps.push(ref);
    for (const ref of deps) {
      const target = declaration(ref.name, ref.span);
      if (d.kind === "let" && target.kind !== "let")
        fail("E_CONST_DEPENDENCY", ref.span, "bind");
      visit(target);
    }
    const get = (name: string, expr: Expr): Type => {
      declaration(name, expr.span);
      return types.get(name)!;
    };
    let type: Type;
    if (d.kind === "slider") type = "number";
    else if (d.kind === "toggle") type = "boolean";
    else if (d.kind === "choice") type = "text";
    else if (d.kind === "data") type = d.table.columns;
    else if (d.kind === "view") {
      type = types.get(d.source)!;
      if (typeof type === "string") fail("E_TYPE", d.span);
      if (d.where && infer(d.where, get, budget, type) !== "boolean")
        fail("E_TYPE", d.where.span);
      if (d.sort && !type.some((c) => c.name === d.sort))
        fail("E_COLUMN_UNKNOWN", d.span);
    } else {
      type = infer(d.expression, get, budget);
      if (typeof type !== "string") fail("E_TYPE", d.expression.span);
    }

    types.set(d.name, type);
    order.push(d);
  }
  ir.declarations.forEach(visit);
  const get = (name: string, expr: Expr): Type => {
    declaration(name, expr.span);
    return types.get(name)!;
  };
  const schema = (name: string, span: Span): readonly Column[] => {
    declaration(name, span);
    const type = types.get(name)!;
    if (typeof type === "string") fail("E_TYPE", span);
    return type;
  };
  let charts = 0;
  walkFlow(ir.flow, (node) => {
    budget.charge(node.span);
    if (node.kind === "interpolation") {
      const type = infer(node.expression, get, budget);
      if (type !== "number" && type !== "text" && type !== "boolean")
        fail("E_TYPE", node.expression.span);
    }
    if (
      node.kind === "when" &&
      infer(node.condition, get, budget) !== "boolean"
    )
      fail("E_TYPE", node.condition.span);
    if (node.kind === "data-table") schema(node.source, node.span);
    if (node.kind !== "chart") return;
    budget.limit("chartCount", ++charts, node.span);
    const c = node.chart,
      columns = schema(c.source, c.span);
    const x = columns.find((col) => col.name === c.x);
    if (!x) fail("E_COLUMN_UNKNOWN", locations.get(`${c.id}:option:x`)!);
    if (
      x.type === "boolean" ||
      ((c.kind === "scatter" || c.kind === "histogram") && x.type !== "number")
    )
      fail("E_TYPE", c.span);
    if (c.y?.kind === "columns") {
      budget.limit("chartSeries", c.y.columns.length, c.span);
      for (const name of c.y.columns) {
        const col = columns.find((col) => col.name === name);
        if (!col) fail("E_COLUMN_UNKNOWN", locations.get(`${c.id}:option:y`)!);
        if (col.type !== "number") fail("E_TYPE", c.span);
      }
    } else if (c.y && infer(c.y.expression, get, budget, columns) !== "number")
      fail("E_TYPE", c.y.expression.span);
    if (c.select) {
      const target = controls.get(c.select);
      if (!target || target.kind !== (x.type === "text" ? "choice" : "slider"))
        fail("E_SELECTION_TARGET", c.span);
    }
  });
  const constants = new Map<string, RuntimeValue>();
  for (const d of order)
    if (d.kind === "let")
      constants.set(
        d.name,
        evaluate(d.expression, {
          get: (name) => constants.get(name)!,
          metadata: ir.metadata,
          budget,
        }),
      );
  return {
    order,
    controls,
    constants,
    limits: budget.limits,
    locations,
    compileOperations: budget.used,
  };
}
