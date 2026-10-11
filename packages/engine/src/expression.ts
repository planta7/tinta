import type {
  Column,
  Expr,
  Metadata,
  Scalar,
  ScalarType,
  TableValue,
  Value,
} from "@tinta-lang/types";
import { Budget, fail, scalarType } from "./common.js";

export type Type =
  | ScalarType
  | "list:never"
  | "list:text"
  | "list:number"
  | "list:boolean"
  | readonly Column[];

export type RuntimeValue = Value | TableValue;

export interface Environment {
  readonly get: (name: string) => RuntimeValue;
  readonly metadata: Metadata;
  readonly budget: Budget;
  readonly row?: ReadonlyMap<string, Scalar>;
}

export function tableType(type: Type, expr: Expr): readonly Column[] {
  if (typeof type === "string") fail("E_TYPE", expr.span);
  return type;
}

export function infer(
  expr: Expr,
  get: (name: string, expr: Expr) => Type,
  budget: Budget,
  columns?: readonly Column[],
): Type {
  budget.charge(expr.span);
  const visit = (child: Expr): Type => infer(child, get, budget, columns);
  const requireType = (child: Expr, expected: Type): void => {
    if (visit(child) !== expected) fail("E_TYPE", child.span);
  };

  switch (expr.kind) {
    case "literal":
      return scalarType(expr.value);
    case "name":
      return get(expr.name, expr);
    case "row-field": {
      if (!columns) fail("E_ROW_SCOPE", expr.span);
      const column = columns.find((c) => c.name === expr.field);
      if (!column) fail("E_COLUMN_UNKNOWN", expr.span);
      return column.type;
    }
    case "list": {
      let item: ScalarType | "never" = "never";
      for (const child of expr.items) {
        const type = visit(child);
        if (type !== "text" && type !== "number" && type !== "boolean")
          fail("E_TYPE", child.span);
        if (item !== "never" && item !== type) fail("E_TYPE", child.span);
        item = type;
      }
      return `list:${item}`;
    }
    case "unary": {
      const type = expr.operator === "not" ? "boolean" : "number";
      requireType(expr.operand, type);
      return type;
    }
    case "binary": {
      const a = visit(expr.left),
        b = visit(expr.right);
      if (expr.operator === "==" || expr.operator === "!=") {
        if (a !== b || (a !== "number" && a !== "text" && a !== "boolean"))
          fail("E_TYPE", expr.span);
        return "boolean";
      }
      const logical = expr.operator === "and" || expr.operator === "or";
      if (a !== (logical ? "boolean" : "number") || a !== b)
        fail("E_TYPE", expr.span);
      return logical || ["<", "<=", ">", ">="].includes(expr.operator)
        ? "boolean"
        : "number";
    }
    case "call": {
      const args = expr.arguments;
      const arity =
        expr.name === "if"
          ? 3
          : ["count", "percent", "money"].includes(expr.name)
            ? 1
            : 2;
      if (
        args.length !== arity &&
        !(expr.name === "round" && args.length === 1)
      )
        fail("E_FUNCTION_ARITY", expr.span);
      if (expr.name === "if") {
        requireType(args[0]!, "boolean");
        const a = visit(args[1]!),
          b = visit(args[2]!);
        if (typeof a !== "string" || typeof b !== "string")
          fail("E_TYPE", expr.span);
        if (a === b) return a;
        if (a === "list:never" && b.startsWith("list:")) return b;
        if (b === "list:never" && a.startsWith("list:")) return a;
        fail("E_TYPE", expr.span);
      }
      if (expr.name === "count") {
        const type = visit(args[0]!);
        if (typeof type === "string" && !type.startsWith("list:"))
          fail("E_TYPE", expr.span);
        return "number";
      }
      if (expr.name === "sum" || expr.name === "mean") {
        const schema = tableType(visit(args[0]!), args[0]!);
        const column = args[1]!;
        if (column.kind !== "literal" || typeof column.value !== "string")
          fail("E_TYPE", column.span);
        const found = schema.find((c) => c.name === column.value);
        if (!found) fail("E_COLUMN_UNKNOWN", column.span);
        if (found.type !== "number") fail("E_TYPE", column.span);
        return "number";
      }
      args.forEach((arg) => requireType(arg, "number"));

      return ["fixed", "percent", "money"].includes(expr.name)
        ? "text"
        : "number";
    }
  }
}

export function numeric(value: number, expr: Expr): number {
  if (!Number.isFinite(value)) fail("E_NUMBER_RANGE", expr.span, "evaluate");
  return value === 0 ? 0 : value;
}

export function format(value: Scalar, metadata: Metadata): string {
  if (typeof value !== "number") return String(value);
  if (Math.abs(value) >= 1e21 || (value !== 0 && Math.abs(value) < 1e-10))
    return String(value);
  return new Intl.NumberFormat(metadata.locale, {
    useGrouping: false,
    maximumFractionDigits: 10,
  }).format(value);
}

export function evaluate(expr: Expr, env: Environment): RuntimeValue {
  env.budget.charge(expr.span);
  const visit = (child: Expr): RuntimeValue => evaluate(child, env);
  const number = (child: Expr): number => visit(child) as number;

  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "name":
      return env.get(expr.name);
    case "row-field":
      return env.row!.get(expr.field)!;
    case "list":
      return expr.items.map((item) => visit(item) as Scalar);
    case "unary":
      return expr.operator === "not"
        ? !visit(expr.operand)
        : numeric(
            (expr.operator === "-" ? -1 : 1) * number(expr.operand),
            expr,
          );
    case "binary": {
      const a = visit(expr.left);
      if (expr.operator === "and") return a ? visit(expr.right) : false;
      if (expr.operator === "or") return a ? true : visit(expr.right);
      const b = visit(expr.right);
      if (expr.operator === "==") return a === b;
      if (expr.operator === "!=") return a !== b;
      const x = a as number,
        y = b as number;

      switch (expr.operator) {
        case "+":
          return numeric(x + y, expr);
        case "-":
          return numeric(x - y, expr);
        case "*":
          return numeric(x * y, expr);
        case "/":
        case "%":
          if (y === 0) fail("E_DIV_ZERO", expr.span, "evaluate");
          return numeric(expr.operator === "/" ? x / y : x % y, expr);
        case "<":
          return x < y;
        case "<=":
          return x <= y;
        case ">":
          return x > y;
        case ">=":
          return x >= y;
      }
      throw new Error("Unreachable validated binary operator.");
    }
    case "call": {
      const args = expr.arguments;
      if (expr.name === "if")
        return visit(args[0]!) ? visit(args[1]!) : visit(args[2]!);
      if (expr.name === "count") {
        const value = visit(args[0]!) as readonly Scalar[] | TableValue;
        return "rows" in value ? value.rows.length : value.length;
      }
      if (expr.name === "sum" || expr.name === "mean") {
        const table = visit(args[0]!) as TableValue;
        const index = table.columns.findIndex(
          (c) => c.name === visit(args[1]!),
        );
        if (expr.name === "mean" && !table.rows.length)
          fail("E_EMPTY_MEAN", expr.span, "evaluate");
        let total = 0;
        for (const row of table.rows) {
          env.budget.charge(expr.span);
          total = numeric(total + (row.cells[index] as number), expr);
        }
        return expr.name === "sum"
          ? total
          : numeric(total / table.rows.length, expr);
      }

      const a = number(args[0]!);
      const b = args[1] ? number(args[1]) : 0;
      if (
        (expr.name === "round" || expr.name === "fixed") &&
        (!Number.isInteger(b) || b < 0 || b > 10)
      )
        fail("E_DIGITS_RANGE", expr.span, "evaluate");
      switch (expr.name) {
        case "min":
          return Math.min(a, b);
        case "max":
          return Math.max(a, b);
        case "pow":
          return numeric(Math.pow(a, b), expr);
        case "round":
          return numeric(
            Math.round(numeric(a * 10 ** b, expr)) / 10 ** b,
            expr,
          );
        case "fixed":
          return new Intl.NumberFormat(env.metadata.locale, {
            useGrouping: false,
            minimumFractionDigits: b,
            maximumFractionDigits: b,
          }).format(a);
        case "percent":
          return new Intl.NumberFormat(env.metadata.locale, {
            style: "percent",
            useGrouping: false,
            minimumFractionDigits: 0,
            maximumFractionDigits: 1,
          }).format(a);
        case "money": {
          const digits = env.metadata.currency === "JPY" ? 0 : 2;
          return new Intl.NumberFormat(env.metadata.locale, {
            style: "currency",
            currency: env.metadata.currency,
            currencyDisplay: "symbol",
            useGrouping: true,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(a);
        }
      }
    }
  }
}
