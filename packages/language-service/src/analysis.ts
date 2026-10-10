import { analyzeProgram, compile, createSession } from "@tinta/engine";
import {
  parseRecovering,
  expressionLexemes,
  type ParsedSource,
  type SyntaxNode,
} from "@tinta/syntax";
import { hash } from "@tinta/types/common";
import type {
  CompilerOptions,
  Expr,
  Result,
  SourceInput,
  Span,
} from "@tinta/types";
import type {
  AnalysisSnapshot,
  EditorReference,
  EditorSymbol,
  EditorToken,
  EditorType,
  SourceIdentity,
} from "@tinta/types/editor";

export type AnalysisVersion = Pick<
  SourceIdentity,
  "documentInstance" | "editorVersion" | "sourceRevision"
>;

export function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

// A weak cache owns parser data only for live snapshots, never author sessions.
const syntax = new WeakMap<AnalysisSnapshot, ParsedSource>();
export function snapshotSyntax(
  snapshot: AnalysisSnapshot,
): ParsedSource | undefined {
  const cached = syntax.get(snapshot);
  if (cached) return cached;

  const parsed = parseRecovering({
    uri: snapshot.identity.uri,
    profile: snapshot.identity.profile,
    text: snapshot.sourceText,
  });
  return parsed.ok ? parsed.value : undefined;
}

export function analyze(
  input: SourceInput,
  version: AnalysisVersion,
  options?: CompilerOptions,
): Result<AnalysisSnapshot> {
  if (
    !/^[0-9a-f]{32}$/.test(version.documentInstance) ||
    !Number.isSafeInteger(version.editorVersion) ||
    version.editorVersion < 1 ||
    !Number.isSafeInteger(version.sourceRevision) ||
    version.sourceRevision < 0 ||
    input.uri.length > 4096 ||
    !["markdown", "tinta"].includes(input.profile)
  )
    throw new TypeError("Invalid analysis identity.");
  const parsed = parseRecovering(input, options);
  const compiled = compile(input, options);
  if (!parsed.ok) return { ok: false, diagnostics: compiled.diagnostics };
  let diagnostics = compiled.diagnostics;
  let valid = false;
  const types = new Map<string, EditorType>();
  if (compiled.ok) {
    for (const binding of analyzeProgram(compiled.value))
      types.set(binding.name, binding.type);
    const session = createSession(compiled.value);
    diagnostics = session.ok ? compiled.diagnostics : session.diagnostics;
    if (session.ok) {
      try {
        valid = true;
      } finally {
        session.value.destroy();
      }
    }
  }
  const data = indexes(parsed.value, types, compiled.ok);
  const snapshot: AnalysisSnapshot = immutable({
    identity: {
      uri: input.uri,
      profile: input.profile,
      documentInstance: version.documentInstance,
      editorVersion: version.editorVersion,
      sourceRevision: version.sourceRevision,
      sourceSha256: hash(parsed.value.bytes),
    },
    sourceText: parsed.value.source,
    validity: valid ? "valid" : "invalid",
    completeness: compiled.ok ? "semantic" : "partial",
    diagnostics,
    ...data,
  });
  // Bytes are retained only inside this module; no caller receives their mutable buffer.
  syntax.set(snapshot, parsed.value);
  return { ok: true, value: snapshot, diagnostics: snapshot.diagnostics };
}

function indexes(
  parsed: ParsedSource,
  types: ReadonlyMap<string, EditorType>,
  semantic: boolean,
): Pick<AnalysisSnapshot, "tokens" | "symbols" | "references"> {
  const tokens: EditorToken[] = [];
  const symbols: EditorSymbol[] = [];
  const references: EditorReference[] = [];
  const pending: {
    name: string;
    span: Span;
  }[] = [];
  const token = (kind: EditorToken["kind"], span: Span): void => {
    tokens.push({ kind, span });
  };
  const plain = (node: SyntaxNode): string =>
    node.kind === "interpolation"
      ? ""
      : (node.value ?? node.children.map(plain).join(""));
  const expression = (expr: Expr, columnLiteral = false): void => {
    if (["name", "row-field", "call", "literal"].includes(expr.kind)) {
      const lexemes = expressionLexemes(parsed, expr.span);
      const exact =
        expr.kind === "name"
          ? lexemes.find((item) => item.raw === expr.name)
          : expr.kind === "row-field"
            ? lexemes.find((item) => item.raw === expr.field)
            : expr.kind === "call"
              ? lexemes.find((item) => item.raw === expr.name)
              : lexemes.find(
                  (item) =>
                    item.raw === (expr.kind === "literal" ? expr.raw : ""),
                );
      if (exact) {
        const span = lexicalSpan(parsed, expr.span, exact.start, exact.end);
        token(
          expr.kind === "name"
            ? "reference"
            : expr.kind === "row-field"
              ? "column"
              : expr.kind === "call"
                ? "function"
                : columnLiteral &&
                    expr.kind === "literal" &&
                    typeof expr.value === "string"
                  ? "column"
                  : "literal",
          span,
        );
        if (expr.kind === "name") pending.push({ name: expr.name, span });
      }
    }
    if (expr.kind === "binary") {
      expression(expr.left);
      expression(expr.right);
    } else if (expr.kind === "unary") expression(expr.operand);
    else if (expr.kind === "list")
      expr.items.forEach((item) => expression(item, columnLiteral));
    else if (expr.kind === "call")
      expr.arguments.forEach((item, index) =>
        expression(item, index === 1 && ["sum", "mean"].includes(expr.name)),
      );
  };
  const visit = (node: SyntaxNode): void => {
    if (node.kind === "heading")
      symbols.push({
        id: node.id,
        name: plain(node),
        kind: "heading",
        extent: node.span,
        selection: node.span,
      });
    const d = node.directive;
    if (d) {
      if (d.binding && d.bindingSpan) {
        const type = types.get(d.binding);
        symbols.push({
          id: node.id,
          name: d.binding,
          kind:
            d.name === "let"
              ? "constant"
              : d.name === "calc"
                ? "calculation"
                : d.name === "data"
                  ? "table"
                  : d.name === "view"
                    ? "view"
                    : "control",
          extent: node.span,
          selection: d.bindingSpan,
          ...(type ? { type } : {}),
        });
        token("declaration", d.bindingSpan);
      }
      if (d.source && d.sourceSpan) {
        pending.push({ name: d.source, span: d.sourceSpan });
        token("reference", d.sourceSpan);
      }
      for (const span of Object.values(d.optionSpans ?? {}))
        token("option", span);
      d.columns?.forEach((column, index) => {
        const span = d.columnNameSpans![index]!;
        symbols.push({
          id: `${node.id}:column:${index}`,
          name: column.name,
          kind: "column",
          extent: d.columnSpans![index]!,
          selection: span,
          ...(semantic
            ? { type: { kind: "scalar" as const, scalar: column.type } }
            : {}),
        });
        token("column", span);
      });
      if (d.expression) expression(d.expression);
      for (const [key, value] of Object.entries(d.options)) {
        const columnLiteral =
          (d.name === "view" && key === "sort") ||
          (d.name === "chart" && (key === "x" || key === "y"));
        expression(value, columnLiteral);
      }
    }
    if (node.expression) expression(node.expression);
    node.children.forEach(visit);
  };
  for (const region of parsed.regions) {
    if (region.kind !== "directive") continue;
    const head = region.lexemes[0]!;
    token("directive", lexicalSpan(parsed, region.span, head.start, head.end));
  }
  visit(parsed.tree);
  // Invalid programs intentionally expose syntax only, including duplicate declarations.
  if (semantic) {
    const bindings = new Map(
      symbols
        .filter((item) => !["heading", "column"].includes(item.kind))
        .map((item) => [item.name, item.id]),
    );
    for (const ref of pending) {
      const target = bindings.get(ref.name);
      if (target) references.push({ span: ref.span, target });
    }
  }
  tokens.sort(
    (a, b) =>
      a.span.start.offset - b.span.start.offset ||
      a.span.end.offset - b.span.end.offset,
  );
  return { tokens, symbols, references };
}

function lexicalSpan(
  parsed: ParsedSource,
  containing: Span,
  start: number,
  end: number,
): Span {
  const position = (offset: number) => {
    let line = containing.start.line;
    let column = containing.start.column;
    for (let i = containing.start.offset; i < offset; i++) {
      if (parsed.source[i] === "\r") {
        line++;
        column = 1;
        if (parsed.source[i + 1] === "\n" && i + 1 < offset) i++;
      } else if (parsed.source[i] === "\n") {
        line++;
        column = 1;
      } else column++;
    }
    return { offset, line, column };
  };
  return { uri: containing.uri, start: position(start), end: position(end) };
}
