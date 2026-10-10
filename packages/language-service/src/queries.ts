import { editingSite, type EditingSite, type SyntaxNode } from "@tinta/syntax";
import type { Span } from "@tinta/types";
import type {
  AnalysisSnapshot,
  CompletionContext,
  EditorAnalysisQueries,
  EditorHelp,
  EditorSymbol,
} from "@tinta/types/editor";
import { immutable, snapshotSyntax } from "./analysis.js";
import { catalog } from "./catalog.js";

function contains(span: Span, offset: number): boolean {
  return span.start.offset <= offset && offset < span.end.offset;
}

function globals(snapshot: AnalysisSnapshot): readonly EditorSymbol[] {
  const symbols = snapshot.symbols.filter(
    (item) => item.kind !== "heading" && item.kind !== "column",
  );
  const counts = new Map<string, number>();
  for (const item of symbols)
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  return symbols.filter((item) => counts.get(item.name) === 1);
}

function columns(snapshot: AnalysisSnapshot, name: string): readonly string[] {
  const global = globals(snapshot).find((item) => item.name === name);
  if (!global) return [];
  if (global.type?.kind === "table")
    return global.type.columns.map((item) => item.name);
  // A successfully parsed data header is useful syntax even when another region fails.
  let result: readonly string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.id === global.id && node.directive?.name === "data")
      result = node.directive.columns!.map((item) => item.name);
    node.children.forEach(visit);
  };
  const parsed = snapshotSyntax(snapshot);
  if (parsed) visit(parsed.tree);
  return result;
}

function names(
  snapshot: AnalysisSnapshot,
  site: EditingSite,
): readonly string[] {
  const bindings = globals(snapshot);
  const command = site.directive as keyof typeof catalog.options | undefined;
  switch (site.kind) {
    case "none":
      return [];
    case "directive":
      return [...catalog.directives, "end"];
    case "option":
      return command
        ? catalog.options[command].filter(
            (name) => !site.usedOptions?.includes(name),
          )
        : [];
    case "selection":
      return bindings
        .filter((item) => item.kind === "control")
        .map((item) => item.name);
    case "column": {
      const result = site.table ? columns(snapshot, site.table) : [];
      return site.quoted ? result.map((name) => JSON.stringify(name)) : result;
    }
    case "expression":
      if (site.option === "source")
        return bindings
          .filter((item) => item.kind === "table" || item.kind === "view")
          .map((item) => item.name);
      return [
        ...bindings
          .filter((item) => command !== "let" || item.kind === "constant")
          .map((item) => item.name),
        ...catalog.functions,
        "true",
        "false",
        "not",
        ...(site.table ? ["row"] : []),
      ];
    case "literal":
      if (site.option === "chartType") return catalog.chartTypes;
      if (site.option === "locale")
        return catalog.locales.map((name) => JSON.stringify(name));
      if (site.option === "currency")
        return catalog.currencies.map((name) => JSON.stringify(name));
      if (site.option === "version") return ['"1.0"'];
      if (
        site.option === "descending" ||
        (command === "toggle" && site.option === "initial")
      )
        return ["true", "false"];
      if (site.option === "bins") return ["8"];
      if (
        ["min", "max", "step"].includes(site.option ?? "") ||
        (command === "slider" && site.option === "initial")
      )
        return ["0", "1"];
      if (site.option === "options") return ['["First", "Second"]'];
      return ['"Text"'];
  }
}

export function completion(
  snapshot: AnalysisSnapshot,
  sourceOffset: number,
): CompletionContext {
  const parsed = snapshotSyntax(snapshot);
  if (!parsed) throw new TypeError("Expected a language-service snapshot.");
  const site = editingSite(parsed, sourceOffset);
  const enabled = snapshot.identity.profile === "tinta";
  return immutable({
    replacement: site.replacement,
    kind: enabled ? site.kind : "none",
    allowedNames: enabled ? names(snapshot, site) : [],
  });
}

export function help(
  snapshot: AnalysisSnapshot,
  sourceOffset: number,
): EditorHelp | undefined {
  const token = snapshot.tokens.find((item) =>
    contains(item.span, sourceOffset),
  );
  if (!token) return undefined;
  const raw = snapshot.sourceText.slice(
    token.span.start.offset,
    token.span.end.offset,
  );
  if (token.kind === "function") {
    const signature =
      catalog.signatures[raw as keyof typeof catalog.signatures];
    return signature
      ? immutable({
          span: token.span,
          text: `Built-in ${raw}.`,
          signatures: [signature],
        })
      : undefined;
  }
  if (token.kind === "directive") {
    const text =
      catalog.descriptions[raw.slice(1) as keyof typeof catalog.descriptions];
    return text
      ? immutable({ span: token.span, text, signatures: [] })
      : undefined;
  }
  if (token.kind === "option")
    return immutable({
      span: token.span,
      text: `${raw}: directive option. Static options require literals; view where and computed chart y accept expressions, and select requires a bare control name.`,
      signatures: [],
    });
  const reference = snapshot.references.find((item) =>
    contains(item.span, sourceOffset),
  );
  const symbol = reference
    ? snapshot.symbols.find((item) => item.id === reference.target)
    : snapshot.symbols.find((item) => contains(item.selection, sourceOffset));
  if (!symbol) return undefined;
  const type = symbol.type;
  const label = !type
    ? "type unavailable"
    : type.kind === "scalar"
      ? type.scalar
      : type.kind === "list"
        ? `list<${type.scalar}>`
        : `table<${type.columns.map((column) => `${column.name}: ${column.type}`).join(", ")}>`;
  return immutable({
    span: token.span,
    text: `${symbol.name}: ${label}`,
    signatures: [],
  });
}

export function definition(
  snapshot: AnalysisSnapshot,
  sourceOffset: number,
): Span | undefined {
  const reference = snapshot.references.find((item) =>
    contains(item.span, sourceOffset),
  );
  return reference
    ? snapshot.symbols.find((item) => item.id === reference.target)?.selection
    : undefined;
}

export function references(
  snapshot: AnalysisSnapshot,
  symbolId: string,
): readonly Span[] {
  return immutable(
    snapshot.references
      .filter((item) => item.target === symbolId)
      .map((item) => item.span),
  );
}

export const queries: EditorAnalysisQueries = Object.freeze({
  completion,
  help,
  definition,
  references,
});
