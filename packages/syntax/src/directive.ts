import type { Column, Expr, Scalar, Span } from "@tinta-lang/types";
import {
  ExpressionParser,
  identifier,
  numberPattern,
  stringValue,
} from "./expression.js";
import { registry } from "./registry.js";
import { Source } from "./source.js";

export type DirectiveName = (typeof registry.directives)[number];

export interface DataRowSyntax {
  readonly cells: readonly Scalar[];
  readonly cellSpans: readonly Span[];
  readonly span: Span;
}

export interface DirectiveSyntax {
  readonly name: DirectiveName | "end";
  readonly binding?: string;
  readonly bindingSpan?: Span;
  readonly sourceSpan?: Span;
  readonly optionSpans?: Readonly<Record<string, Span>>;
  readonly columnNameSpans?: readonly Span[];
  readonly source?: string;
  readonly chartType?: (typeof registry.chartTypes)[number];
  readonly expression?: Expr;
  readonly summary?: string;
  readonly options: Readonly<Record<string, Expr>>;
  readonly columns?: readonly Column[];
  readonly columnSpans?: readonly Span[];
  readonly rows?: readonly DataRowSyntax[];
}

export const optionKeys = {
  meta: ["version", "title", "locale", "currency"],
  let: [],
  calc: [],
  slider: ["min", "max", "step", "label"],
  toggle: ["label"],
  choice: ["options", "label"],
  when: [],
  details: [],
  data: [],
  view: ["where", "sort", "descending"],
  table: ["title"],
  chart: ["x", "y", "title", "xLabel", "yLabel", "select", "bins"],
} as const;

export function parseDirective(
  source: Source,
  start: number,
  end: number,
): DirectiveSyntax {
  const match = /^@([a-z][a-z0-9_]*)/.exec(source.text.slice(start, end))!;
  const name = match[1]!;
  source.lexemes.push({
    raw: match[0],
    start,
    end: start + match[0].length,
  });
  if (
    name !== "end" &&
    !(registry.directives as readonly string[]).includes(name)
  )
    source.fail(
      "E_DIRECTIVE_UNKNOWN",
      start,
      start + match[0].length,
      "Unknown directive.",
    );
  if (name === "data") return parseData(source, start, end);

  const p = new ExpressionParser(source, start + match[0].length, end);
  const options: Record<string, Expr> = Object.create(null) as Record<
    string,
    Expr
  >;
  if (name === "end") {
    p.finish("E_BLOCK_END");
    return { name, options };
  }

  const command = name as DirectiveName;
  const result: {
    name: DirectiveName;
    binding?: string;
    bindingSpan?: Span;
    sourceSpan?: Span;
    optionSpans: Record<string, Span>;
    source?: string;
    chartType?: DirectiveSyntax["chartType"];
    expression?: Expr;
    summary?: string;
    options: Record<string, Expr>;
  } = {
    name: command,
    options,
    optionSpans: Object.create(null) as Record<string, Span>,
  };
  if (
    command !== "meta" &&
    command !== "details" &&
    !/^[ \t]/.test(source.text.slice(start + match[0].length))
  )
    source.fail(
      "E_DIRECTIVE_SYNTAX",
      start,
      end,
      "Directive operands require whitespace.",
    );
  if (["let", "calc", "slider", "toggle", "choice", "view"].includes(command)) {
    const binding = p.take();
    result.binding = identifier(source, binding);
    result.bindingSpan = source.span(binding.start, binding.end);
    p.expect("=", "E_DIRECTIVE_SYNTAX");
    if (command === "view") {
      const table = p.take();
      result.source = identifier(source, table);
      result.sourceSpan = source.span(table.start, table.end);
    } else result.expression = p.parse();
  } else if (command === "when") result.expression = p.parse();
  else if (command === "details" && p.peek().raw) {
    const token = p.take();
    if (!token.raw.startsWith('"'))
      source.fail(
        "E_DIRECTIVE_SYNTAX",
        token.start,
        token.end,
        "Details summary must be a text literal.",
      );
    result.summary = stringValue(source, token);
  } else if (command === "table") {
    const table = p.take();
    result.source = identifier(source, table);
    result.sourceSpan = source.span(table.start, table.end);
  } else if (command === "chart") {
    const type = p.take();
    if (!(registry.chartTypes as readonly string[]).includes(type.raw))
      source.fail("E_CHART_TYPE", type.start, type.end, "Unknown chart type.");
    result.chartType = type.raw as NonNullable<DirectiveSyntax["chartType"]>;
    const table = p.take();
    if (table.start === type.end)
      source.fail(
        "E_DIRECTIVE_SYNTAX",
        type.start,
        table.end,
        "Chart operands require whitespace.",
      );
    result.source = identifier(source, table);
    result.sourceSpan = source.span(table.start, table.end);
  }

  const group = p.accept("(");
  if (group) {
    if (["let", "calc", "when", "details"].includes(command))
      source.fail(
        "E_DIRECTIVE_SYNTAX",
        start,
        end,
        "This directive has no option list.",
      );
    if (!p.accept(")")) {
      do {
        const key = p.take();
        if (!(optionKeys[command] as readonly string[]).includes(key.raw))
          source.fail(
            "E_PROPERTY_UNKNOWN",
            key.start,
            key.end,
            "Unknown option key.",
          );
        if (Object.hasOwn(options, key.raw))
          source.fail(
            "E_PROPERTY_DUPLICATE",
            key.start,
            key.end,
            "Duplicate option key.",
          );
        p.expect(":", "E_DIRECTIVE_SYNTAX");
        result.optionSpans[key.raw] = source.span(key.start, key.end);
        options[key.raw] = p.parse();
      } while (p.accept(",") && p.peek().raw !== ")");
      p.expect(")", "E_DIRECTIVE_SYNTAX");
    }
  }
  if (["meta", "choice", "chart"].includes(command) && !group)
    source.fail(
      "E_DIRECTIVE_SYNTAX",
      start,
      end,
      "An option list is required.",
    );
  p.finish("E_DIRECTIVE_SYNTAX");

  if (command === "slider" || command === "toggle" || command === "choice") {
    const expr = result.expression!;
    const numeric =
      (expr.kind === "literal" && typeof expr.value === "number") ||
      (expr.kind === "unary" &&
        (expr.operator === "+" || expr.operator === "-") &&
        expr.operand.kind === "literal" &&
        typeof expr.operand.value === "number" &&
        expr.span.end.offset - expr.span.start.offset ===
          1 + expr.operand.raw.length);
    const valid =
      command === "slider"
        ? numeric &&
          /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(
            source.text.slice(expr.span.start.offset, expr.span.end.offset),
          )
        : expr.kind === "literal" &&
          typeof expr.value === (command === "toggle" ? "boolean" : "string") &&
          source.text.slice(expr.span.start.offset, expr.span.end.offset) ===
            expr.raw;
    if (!valid)
      source.fail(
        "E_DIRECTIVE_SYNTAX",
        expr.span.start.offset,
        expr.span.end.offset,
        "Control initial value must be a literal of its declared type.",
      );
  }

  // No semantic defaults or binding/type evaluation is performed here.
  return result as DirectiveSyntax;
}

function splitCells(
  source: Source,
  start: number,
  end: number,
): {
  start: number;
  end: number;
  raw: string;
}[] {
  const cells: {
    start: number;
    end: number;
    raw: string;
  }[] = [];
  let begin = start,
    quote = false,
    escaped = false,
    initial = true;

  for (let i = start; i <= end; i++) {
    source.charge("compileOperations", i);
    const c = source.text[i];
    if (i === end || (c === "|" && !quote)) {
      cells.push({
        start: begin,
        end: i,
        raw: source.text.slice(begin, i).replace(/^[ \t]+|[ \t]+$/g, ""),
      });
      source.limit("tableColumns", cells.length, begin);
      begin = i + 1;
      initial = true;
    } else if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quote = false;
    } else if (initial && c !== " " && c !== "\t") {
      quote = c === '"';
      initial = false;
    }
  }

  return cells;
}

function parseData(
  source: Source,
  start: number,
  end: number,
): DirectiveSyntax {
  const lines: {
    start: number;
    end: number;
    raw: string;
  }[] = [];
  let offset = start;

  for (const raw of source.text.slice(start, end).split(/\r\n|\r|\n/)) {
    lines.push({
      start: offset,
      end: offset + raw.length,
      raw,
    });
    offset += raw.length;
    if (source.text[offset] === "\r") offset++;
    if (source.text[offset] === "\n") offset++;
  }

  const opener = lines.shift()!;

  const p = new ExpressionParser(source, start + 5, opener.end);
  if (!/^[ \t]/.test(source.text.slice(start + 5)))
    source.fail(
      "E_DIRECTIVE_SYNTAX",
      start,
      opener.end,
      "Data name requires whitespace.",
    );

  const bindingToken = p.take();
  const binding = identifier(source, bindingToken);
  p.finish("E_DIRECTIVE_SYNTAX");
  const close = lines[lines.length - 1];
  if (!close || !/^@end[ \t]*$/.test(close.raw))
    source.fail(
      "E_BLOCK_UNCLOSED",
      start,
      opener.end,
      "Data block needs @end.",
    );
  lines.pop();
  const nonblank = lines.filter((line) => !/^[ \t]*$/.test(line.raw));
  const header = nonblank.shift();
  if (!header)
    source.fail("E_DATA_HEADER", start, end, "Data requires a typed header.");

  const names = new Set<string>();
  const headerCells = splitCells(source, header.start, header.end);
  const columns = headerCells.map((cell): Column => {
    const m =
      /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(text|number|boolean)$/.exec(
        cell.raw,
      );
    if (
      !m ||
      names.has(m[1]!) ||
      (registry.reservedIdentifiers as readonly string[]).includes(m[1]!)
    )
      source.fail(
        "E_DATA_HEADER",
        cell.start,
        cell.end,
        "Invalid or duplicate data header.",
      );
    source.limit("identifierUnits", m[1]!.length, cell.start);
    names.add(m[1]!);
    return { name: m[1]!, type: m[2] as Column["type"] };
  });
  source.limit("tableRows", nonblank.length, header.end);
  const rows = nonblank.map((line): DataRowSyntax => {
    if (/^@[a-z][a-z0-9_]*(?=[ \t(]|$)/.test(line.raw))
      source.fail(
        "E_DATA_VALUE",
        line.start,
        line.end,
        "Data cannot contain a directive.",
      );

    const cells = splitCells(source, line.start, line.end);
    if (cells.length !== columns.length)
      source.fail(
        "E_DATA_ARITY",
        line.start,
        line.end,
        "Row width differs from header.",
      );

    const values = cells.map((cell, i): Scalar => {
      source.charge("totalCells", cell.start);
      if (columns[i]!.type === "text") {
        if (cell.raw.startsWith('"'))
          return stringValue(source, cell, "E_DATA_VALUE");
        if (!cell.raw)
          source.fail(
            "E_DATA_VALUE",
            cell.start,
            cell.end,
            "Empty text or directive in data.",
          );
        source.limit("textValueUnits", cell.raw.length, cell.start);
        return cell.raw;
      }
      if (
        columns[i]!.type === "boolean" &&
        ["true", "false"].includes(cell.raw)
      )
        return cell.raw === "true";
      if (columns[i]!.type === "number") {
        source.limit("numberTokenUnits", cell.raw.length, cell.start, 128);
        if (
          numberPattern.test(cell.raw.replace(/^[+-]/, "")) &&
          Number.isFinite(Number(cell.raw))
        )
          return Number(cell.raw);
      }
      source.fail("E_DATA_VALUE", cell.start, cell.end, "Invalid typed cell.");
    });

    return {
      cells: values,
      cellSpans: cells.map((cell) => source.span(cell.start, cell.end)),
      span: source.span(line.start, line.end),
    };
  });

  return {
    name: "data",
    binding,
    bindingSpan: source.span(bindingToken.start, bindingToken.end),
    columnNameSpans: headerCells.map((cell, index) => {
      let begin = cell.start;
      while (source.text[begin] === " " || source.text[begin] === "\t") begin++;
      return source.span(begin, begin + columns[index]!.name.length);
    }),
    columns,
    columnSpans: headerCells.map((cell) => source.span(cell.start, cell.end)),
    rows,
    options: {},
  };
}
