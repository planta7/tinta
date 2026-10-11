import type {
  BinaryOperator,
  Builtin,
  Expr,
  UnaryOperator,
} from "@tinta-lang/types";
import { Source } from "./source.js";
import { registry } from "./registry.js";

export interface Lexeme {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export const numberPattern =
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const precedence: Readonly<Record<string, number>> = {
  or: 1,
  and: 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

export function identifier(source: Source, token: Lexeme): string {
  source.limit("identifierUnits", token.raw.length, token.start);
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.raw) ||
    (registry.reservedIdentifiers as readonly string[]).includes(token.raw)
  )
    source.fail(
      "E_NAME_RESERVED",
      token.start,
      token.end,
      "Expected a nonreserved ASCII identifier.",
    );
  return token.raw;
}

export function stringValue(
  source: Source,
  token: Lexeme,
  code = "E_EXPRESSION_SYNTAX",
): string {
  let result: unknown;
  try {
    result = JSON.parse(token.raw);
  } catch {
    source.fail(code, token.start, token.end, "Invalid JSON string.");
  }
  if (
    typeof result !== "string" ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      result,
    )
  )
    source.fail(
      code,
      token.start,
      token.end,
      "String contains an unpaired surrogate.",
    );
  source.limit("textValueUnits", result.length, token.start);

  return result;
}

export class ExpressionParser {
  readonly tokens: Lexeme[] = [];
  cursor = 0;

  constructor(
    readonly source: Source,
    readonly start: number,
    readonly end: number,
  ) {
    let i = start;

    while (i < end) {
      source.charge("compileOperations", i);
      const c = source.text[i]!;
      if (/[ \t\r\n]/.test(c)) {
        i++;
        continue;
      }

      const begin = i;
      if (c === '"') {
        i++;
        while (
          i < end &&
          source.text[i] !== '"' &&
          !/[\r\n]/.test(source.text[i]!)
        ) {
          if (source.text[i] === "\\") i++;
          i++;
        }
        if (source.text[i] === '"') i++;
      } else if (/[A-Za-z_]/.test(c)) {
        while (i < end && /[A-Za-z0-9_]/.test(source.text[i]!)) i++;
      } else if (/[0-9]/.test(c)) {
        while (i < end && /[0-9.eE]/.test(source.text[i]!)) {
          const ch = source.text[i++];
          if ((ch === "e" || ch === "E") && /[+-]/.test(source.text[i] ?? ""))
            i++;
        }
      } else if (["<=", ">=", "==", "!="].includes(source.text.slice(i, i + 2)))
        i += 2;
      else i++;

      this.tokens.push({
        raw: source.text.slice(begin, i),
        start: begin,
        end: i,
      });
    }

    for (const token of this.tokens) source.lexemes.push(token);

    this.tokens.push({
      raw: "",
      start: end,
      end,
    });
  }

  peek(): Lexeme {
    return this.tokens[this.cursor]!;
  }

  take(): Lexeme {
    const token = this.peek();
    if (token.raw) this.cursor++;
    return token;
  }

  accept(raw: string): boolean {
    if (this.peek().raw !== raw) return false;
    this.take();
    return true;
  }

  expect(raw: string, code = "E_EXPRESSION_SYNTAX"): Lexeme {
    const t = this.take();
    if (t.raw !== raw)
      this.source.fail(code, t.start, t.end, `Expected ${raw}.`);
    return t;
  }

  finish(code = "E_EXPRESSION_SYNTAX"): void {
    if (this.peek().raw)
      this.source.fail(
        code,
        this.peek().start,
        this.peek().end,
        "Unexpected trailing tokens.",
      );
  }

  parse(min = 0, depth = 1): Expr {
    const begin = this.peek().start;
    this.source.limit("expressionDepth", depth, begin);
    let left = this.primary(depth);

    while ((precedence[this.peek().raw] ?? 0) > min) {
      const op = this.take();
      if (
        (op.raw === "and" || op.raw === "or") &&
        /[A-Za-z0-9_]/.test(this.source.text[op.start - 1] ?? "")
      )
        this.source.fail(
          "E_EXPRESSION_SYNTAX",
          op.start,
          op.end,
          "Word operator needs token boundaries.",
        );

      const operator = op.raw as BinaryOperator;
      const right = this.parse(precedence[operator]!, depth + 1);
      left = this.node({
        kind: "binary",
        operator,
        left,
        right,
        span: this.source.span(begin, right.span.end.offset),
      });
    }

    this.source.limit("expressionUnits", left.span.end.offset - begin, begin);

    return left;
  }

  private node<T extends Expr>(node: T): T {
    this.source.charge("astNodes", node.span.start.offset);
    this.source.charge("compileOperations", node.span.start.offset);
    return node;
  }

  private primary(depth: number): Expr {
    const t = this.take(),
      raw = t.raw,
      span = this.source.span(t.start, t.end);
    if (["+", "-", "not"].includes(raw)) {
      const operand = this.parse(6, depth + 1);
      return this.node({
        kind: "unary",
        operator: raw as UnaryOperator,
        operand,
        span: this.source.span(t.start, operand.span.end.offset),
      });
    }

    if (raw === "(") {
      const expr = this.parse(0, depth + 1);
      const close = this.expect(")");
      return { ...expr, span: this.source.span(t.start, close.end) };
    }

    if (raw === "[") {
      const items: Expr[] = [];
      if (!this.accept("]")) {
        do {
          this.source.limit("literalListItems", items.length + 1, t.start);
          items.push(this.parse(0, depth + 1));
        } while (this.accept(",") && this.peek().raw !== "]");
        this.expect("]");
      }
      return this.node({
        kind: "list",
        items,
        span: this.source.span(t.start, this.tokens[this.cursor - 1]!.end),
      });
    }

    if (raw.startsWith('"'))
      return this.node({
        kind: "literal",
        value: stringValue(this.source, t),
        raw,
        span,
      });
    if (raw === "true" || raw === "false")
      return this.node({
        kind: "literal",
        value: raw === "true",
        raw,
        span,
      });

    if (/^[0-9]/.test(raw)) {
      this.source.limit("numberTokenUnits", raw.length, t.start, 128);
      if (!numberPattern.test(raw))
        this.source.fail(
          "E_EXPRESSION_SYNTAX",
          t.start,
          t.end,
          "Invalid numeric token.",
        );

      const value = Number(raw);
      if (!Number.isFinite(value))
        this.source.fail(
          "E_NUMBER_RANGE",
          t.start,
          t.end,
          "Numeric literal must be finite.",
        );

      return this.node({
        kind: "literal",
        value,
        raw,
        span,
      });
    }

    if (raw === "row" && this.accept(".")) {
      const field = this.take();
      if (
        t.end !== this.tokens[this.cursor - 2]!.start ||
        this.tokens[this.cursor - 2]!.end !== field.start
      )
        this.source.fail(
          "E_EXPRESSION_SYNTAX",
          t.start,
          field.end,
          "row.field cannot contain whitespace.",
        );
      return this.node({
        kind: "row-field",
        field: identifier(this.source, field),
        span: this.source.span(t.start, field.end),
      });
    }
    if (
      (registry.functions as readonly string[]).includes(raw) &&
      this.accept("(")
    ) {
      if (
        /[\r\n]/.test(
          this.source.text.slice(t.end, this.tokens[this.cursor - 1]!.start),
        )
      )
        this.source.fail(
          "E_EXPRESSION_SYNTAX",
          t.start,
          this.peek().start,
          "Call opening parenthesis must be on the function-name line.",
        );

      const args: Expr[] = [];
      if (!this.accept(")")) {
        do {
          args.push(this.parse(0, depth + 1));
        } while (this.accept(","));
        this.expect(")");
      }

      return this.node({
        kind: "call",
        name: raw as Builtin,
        arguments: args,
        span: this.source.span(t.start, this.tokens[this.cursor - 1]!.end),
      });
    }
    if (!/^[A-Za-z_]/.test(raw))
      this.source.fail(
        "E_EXPRESSION_SYNTAX",
        t.start,
        t.end,
        "Expected an expression.",
      );

    return this.node({
      kind: "name",
      name: identifier(this.source, t),
      span,
    });
  }
}
