import type { Span } from "@tinta-lang/types";
import type { EditingRegion, ParsedSource, SyntaxNode } from "./parser.js";
import { ExpressionParser, numberPattern, type Lexeme } from "./expression.js";
import { optionKeys } from "./directive.js";
import { registry } from "./registry.js";
import { Source } from "./source.js";

export interface EditingSite {
  readonly replacement: Span;
  readonly kind:
    | "directive"
    | "option"
    | "literal"
    | "expression"
    | "selection"
    | "column"
    | "none";
  readonly directive?: string;
  readonly option?: string;
  readonly table?: string;
  readonly usedOptions?: readonly string[];
  readonly quoted?: boolean;
  readonly numericOnly?: boolean;
  readonly listItem?: boolean;
  readonly chartType?: string;
  readonly xColumn?: string;
  readonly call?: {
    readonly name: string;
    readonly argument: number;
  };
}

const options = Object.fromEntries(
  Object.entries(optionKeys).map(([name, keys]) => [
    name,
    Object.freeze([...keys]),
  ]),
) as typeof optionKeys;

export const editorNames = Object.freeze({
  directives: Object.freeze([...registry.directives]),
  functions: Object.freeze([...registry.functions]),
  chartTypes: Object.freeze([...registry.chartTypes]),
  locales: Object.freeze([...registry.locales]),
  currencies: Object.freeze([...registry.currencies]),
  reserved: Object.freeze([...registry.reservedIdentifiers]),
  options: Object.freeze(options),
});

/** Exact lexical tokens inside an AST expression, including grouped names. */
export function expressionLexemes(
  parsed: ParsedSource,
  span: Span,
): readonly Lexeme[] {
  let lower = 0;
  let upper = parsed.lexemes.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (parsed.lexemes[middle]!.start < span.start.offset) lower = middle + 1;
    else upper = middle;
  }
  const result: Lexeme[] = [];
  for (let index = lower; index < parsed.lexemes.length; index++) {
    const token = parsed.lexemes[index]!;
    if (token.end > span.end.offset) break;
    result.push(token);
  }
  return result;
}

/** Context comes only from active Markdown extension regions and its lexer. */
export function editingSite(parsed: ParsedSource, offset: number): EditingSite {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > parsed.source.length
  )
    throw new RangeError("Offset is outside the source.");
  const source = new Source({
    uri: parsed.tree.span.uri,
    text: parsed.source,
    profile: "tinta",
  });
  const none: EditingSite = {
    kind: "none",
    replacement: source.span(offset, offset),
  };
  const region = parsed.regions.find(
    (item) =>
      item.span.start.offset <= offset && offset <= item.span.end.offset,
  );
  if (!region) {
    let leaf: SyntaxNode | undefined;
    const visit = (node: SyntaxNode): void => {
      if (node.span.start.offset <= offset && offset <= node.span.end.offset) {
        leaf = node;
        node.children.forEach(visit);
      }
    };
    visit(parsed.tree);
    if (leaf?.kind !== "text") return none;
    const start = leaf.span.start.offset;
    const prefix = parsed.source.slice(start, offset);
    if (
      source.position(start).column !== 1 &&
      !(start === 1 && parsed.source[0] === "\uFEFF")
    )
      return none;
    if (!/^@[a-z0-9_]*$/.test(prefix)) return none;
    return { kind: "directive", replacement: source.span(start + 1, offset) };
  }
  return regionSite(source, region, offset);
}

function regionSite(
  source: Source,
  region: EditingRegion,
  offset: number,
): EditingSite {
  const start = region.span.start.offset;
  const none: EditingSite = {
    kind: "none",
    replacement: source.span(offset, offset),
  };
  let commandEnd = start + 1;
  while (/[a-z0-9_]/.test(source.text[commandEnd] ?? "!")) commandEnd++;
  const directive = source.text.slice(start + 1, commandEnd);
  if (region.kind === "directive" && offset <= commandEnd)
    return {
      kind: "directive",
      replacement: source.span(start + 1, commandEnd),
    };
  // A missing interpolation delimiter fails before expression parsing. Reuse its lexer.
  const lexemes =
    region.kind === "directive" ? region.lexemes.slice(1) : region.lexemes;
  const tokens = lexemes.length
    ? lexemes
    : region.kind === "interpolation"
      ? new ExpressionParser(
          source,
          start + 2,
          region.span.end.offset,
        ).tokens.filter((token) => token.raw)
      : [];
  const token =
    tokens.find((item) => item.start <= offset && offset < item.end) ??
    tokens.find((item) => item.end === offset);
  const replace =
    token &&
    (/^[A-Za-z_]/.test(token.raw) ||
      token.raw.startsWith('"') ||
      numberPattern.test(token.raw))
      ? token
      : undefined;
  const replacement = source.span(
    replace?.start ?? offset,
    replace?.end ?? offset,
  );
  const before = tokens.filter(
    (item) => item.end <= (replace?.start ?? offset),
  );
  const expression = (extra: Partial<EditingSite> = {}): EditingSite => {
    const frames: {
      name: string;
      argument: number;
      first?: string;
    }[] = [];
    let previous: Lexeme | undefined;
    for (const item of before) {
      if (item.raw === "(" || item.raw === "[") {
        frames.push({
          name: item.raw === "(" ? (previous?.raw ?? "") : "",
          argument: 0,
        });
      } else if (item.raw === ")" || item.raw === "]") frames.pop();
      else {
        const frame = frames.at(-1);
        if (frame) {
          if (item.raw === ",") frame.argument++;
          else if (frame.argument === 0 && !frame.first) frame.first = item.raw;
        }
      }
      previous = item;
    }
    const frame = frames
      .slice()
      .reverse()
      .find((item) =>
        (editorNames.functions as readonly string[]).includes(item.name),
      );
    const call = frame
      ? { name: frame.name, argument: frame.argument }
      : undefined;
    const context = { ...extra, ...(call ? { call } : {}) };
    if (frame && ["sum", "mean"].includes(frame.name) && frame.argument === 1)
      return {
        ...context,
        kind: "column",
        replacement,
        quoted: true,
        numericOnly: true,
        ...(frame.first ? { table: frame.first } : {}),
      };
    const last = before.at(-1);
    if (last?.raw === "." && before.at(-2)?.raw === "row" && extra.table)
      return { kind: "column", replacement, ...context };
    if (replace?.raw.startsWith('"')) return { ...none, ...context };
    return { kind: "expression", replacement, ...context };
  };
  if (region.kind === "interpolation") {
    if (source.text.slice(offset - 2, offset) === "}}") return none;
    return expression();
  }
  if (!Object.hasOwn(optionKeys, directive) || directive === "data")
    return none;
  const name = directive as keyof typeof optionKeys;
  if (["let", "calc", "when"].includes(name)) {
    const begin =
      name === "when"
        ? commandEnd
        : tokens.find((item) => item.raw === "=")?.end;
    return begin !== undefined && offset >= begin
      ? expression({ directive })
      : none;
  }
  if (name === "details") return { kind: "literal", replacement, directive };
  let operandCount =
    name === "meta" ? 0 : name === "chart" ? 2 : name === "table" ? 1 : 3;
  if (
    ["slider", "toggle", "choice"].includes(name) &&
    ["+", "-"].includes(tokens[2]?.raw ?? "")
  )
    operandCount++;
  const operands = tokens.slice(0, operandCount);
  if (
    operands.length < operandCount ||
    offset <= (operands.at(-1)?.end ?? commandEnd)
  ) {
    if (name === "chart" && (tokens.length === 0 || offset <= tokens[0]!.end))
      return { kind: "literal", replacement, directive, option: "chartType" };
    if (
      name === "table" ||
      (name === "chart" && offset > (tokens[0]?.end ?? commandEnd)) ||
      (name === "view" && offset >= (tokens[1]?.end ?? Infinity))
    )
      return { kind: "expression", replacement, directive, option: "source" };
    if (
      ["slider", "toggle", "choice"].includes(name) &&
      offset >= (tokens[1]?.end ?? Infinity)
    )
      return { kind: "literal", replacement, directive, option: "initial" };
    return none;
  }
  const group = tokens[operandCount];
  if (group?.raw !== "(" || offset <= group.start) return none;
  let depth = 0;
  let key: string | undefined;
  let expectingKey = true;
  const used: string[] = [];
  let xColumn: string | undefined;
  let optionDepth = 0;
  const optionTokens = tokens.slice(operandCount + 1);
  for (let index = 0; index < optionTokens.length; index++) {
    const item = optionTokens[index]!;
    if (optionDepth === 0 && item.raw === ")") break;
    if (
      optionDepth === 0 &&
      (index === 0 || optionTokens[index - 1]?.raw === ",") &&
      optionTokens[index + 1]?.raw === ":"
    ) {
      if (item.start !== replace?.start) used.push(item.raw);
      if (item.raw === "x") {
        try {
          const value: unknown = JSON.parse(optionTokens[index + 2]?.raw ?? "");
          if (typeof value === "string") xColumn = value;
        } catch {
          // An unfinished literal cannot establish a selection type.
        }
      }
    }
    if (item.raw === "(" || item.raw === "[") optionDepth++;
    if (item.raw === ")" || item.raw === "]") optionDepth--;
  }
  let listValue = false;
  for (const item of optionTokens) {
    if (item.start >= (replace?.start ?? offset)) break;
    if (depth === 0 && item.raw === ")") return none;
    if (depth === 0 && item.raw === ",") {
      expectingKey = true;
      key = undefined;
      listValue = false;
      continue;
    }
    if (depth === 0 && expectingKey && item.raw !== ":") {
      key = item.raw;
      expectingKey = false;
    }
    if (depth === 0 && item.raw === "[") listValue = true;
    if (item.raw === "(" || item.raw === "[") depth++;
    if (item.raw === ")" || item.raw === "]") depth--;
  }
  if (expectingKey || (before.at(-1)?.raw !== ":" && key === undefined))
    return {
      kind: "option",
      replacement,
      directive,
      usedOptions: used,
      ...(name === "chart" ? { chartType: tokens[0]!.raw } : {}),
    };
  if (!key || !(optionKeys[name] as readonly string[]).includes(key))
    return none;
  const table =
    name === "view"
      ? tokens[2]?.raw
      : name === "chart"
        ? tokens[1]?.raw
        : undefined;
  const extra = {
    directive,
    option: key,
    ...(table ? { table } : {}),
    ...(xColumn ? { xColumn } : {}),
    ...(listValue && depth > 0 ? { listItem: true } : {}),
    ...(name === "chart" ? { chartType: tokens[0]!.raw } : {}),
  };
  if (
    (name === "view" && key === "where") ||
    (name === "chart" &&
      key === "y" &&
      !listValue &&
      !replace?.raw.startsWith('"'))
  )
    return expression(extra);
  if (name === "chart" && key === "select")
    return { kind: "selection", replacement, ...extra };
  if (table && ["x", "y", "sort"].includes(key))
    return {
      kind: "column",
      replacement,
      quoted: true,
      numericOnly: key === "y",
      ...extra,
    };
  return { kind: "literal", replacement, ...extra };
}
