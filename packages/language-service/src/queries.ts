import {
  editingSite,
  type EditingSite,
  type SyntaxNode,
} from "@tinta-lang/syntax";
import type { Span } from "@tinta-lang/types";
import type {
  AnalysisSnapshot,
  CompletionContext,
  EditorAnalysisQueries,
  EditorHelp,
  EditorSymbol,
  EditorSignatureHelp,
} from "@tinta-lang/types/editor";
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
  return symbols.filter(
    (item) =>
      counts.get(item.name) === 1 &&
      !(catalog.reserved as readonly string[]).includes(item.name),
  );
}

function columns(
  snapshot: AnalysisSnapshot,
  name: string,
  numericOnly = false,
  excludeBoolean = false,
): readonly string[] {
  const global = globals(snapshot).find((item) => item.name === name);
  if (!global) return [];
  if (global.type?.kind === "table")
    return global.type.columns
      .filter(
        (item) =>
          (!numericOnly || item.type === "number") &&
          (!excludeBoolean || item.type !== "boolean"),
      )
      .map((item) => item.name);
  // A successfully parsed data header is useful syntax even when another region fails.
  let result: readonly string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.id === global.id && node.directive?.name === "data")
      result = node.directive
        .columns!.filter(
          (item) =>
            (!numericOnly || item.type === "number") &&
            (!excludeBoolean || item.type !== "boolean"),
        )
        .map((item) => item.name);
    node.children.forEach(visit);
  };
  const parsed = snapshotSyntax(snapshot);
  if (parsed) visit(parsed.tree);
  return result;
}

function directiveNames(snapshot: AnalysisSnapshot, offset: number): string[] {
  const parsed = snapshotSyntax(snapshot)!;
  let depth = 0;
  for (const region of parsed.regions) {
    if (region.kind !== "directive" || region.span.start.offset >= offset)
      continue;
    const command = region.lexemes[0]?.raw;
    if (["@when", "@details", "@data"].includes(command ?? "")) depth++;
    else if (command === "@end") depth = Math.max(0, depth - 1);
  }
  const beforeContent = !parsed.tree.children.some(
    (node) =>
      node.span.start.offset < offset &&
      !(node.kind === "html" && node.value?.startsWith("<!--")),
  );
  const hasOtherMeta = parsed.regions.some(
    (region) =>
      region.span.start.offset !== offset && region.lexemes[0]?.raw === "@meta",
  );
  return [...catalog.directives, "end"].filter((name) => {
    if (name === "end") return depth > 0;
    if (name === "meta") return depth === 0 && beforeContent && !hasOtherMeta;
    return depth === 0 || !["let", "calc", "data", "view"].includes(name);
  });
}

function selectionNames(
  snapshot: AnalysisSnapshot,
  site: EditingSite,
  bindings: readonly EditorSymbol[],
): string[] {
  if (site.chartType === "histogram") return [];
  const table = bindings.find((binding) => binding.name === site.table);
  let scalar =
    table?.type?.kind === "table"
      ? table.type.columns.find((column) => column.name === site.xColumn)?.type
      : undefined;
  const controls = new Map<string, string>();
  const visit = (node: SyntaxNode): void => {
    if (node.id === table?.id)
      scalar ??= node.directive?.columns?.find(
        (column) => column.name === site.xColumn,
      )?.type;
    if (node.directive?.binding) controls.set(node.id, node.directive.name);
    node.children.forEach(visit);
  };
  const parsed = snapshotSyntax(snapshot);
  if (parsed) visit(parsed.tree);
  return bindings
    .filter((item) => {
      const kind = controls.get(item.id);
      if (kind !== "slider" && kind !== "choice") return false;
      if (!site.table || !site.xColumn) return true;
      return scalar === "number"
        ? kind === "slider"
        : scalar === "text"
          ? kind === "choice"
          : false;
    })
    .map((item) => item.name);
}

/** Complete call examples use only known built-ins and document-local columns. */
export function functionExample(
  snapshot: AnalysisSnapshot,
  name: string,
): string | undefined {
  if (!(catalog.functions as readonly string[]).includes(name))
    return undefined;
  if (name === "sum" || name === "mean") {
    for (const table of globals(snapshot)) {
      if (table.kind !== "table" && table.kind !== "view") continue;
      const column = columns(snapshot, table.name, true)[0];
      if (column) return `${name}(${table.name}, ${JSON.stringify(column)})`;
    }
    return undefined;
  }
  return catalog.examples[name as keyof typeof catalog.examples];
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
      return directiveNames(snapshot, site.replacement.start.offset - 1);
    case "option":
      return command
        ? catalog.options[command].filter(
            (name) =>
              !site.usedOptions?.includes(name) &&
              (command !== "chart" ||
                (site.chartType === "histogram"
                  ? !["y", "select"].includes(name)
                  : name !== "bins")),
          )
        : [];
    case "selection":
      return selectionNames(snapshot, site, bindings);
    case "column": {
      const result = site.table
        ? columns(
            snapshot,
            site.table,
            site.numericOnly,
            site.directive === "chart" && site.option === "x",
          )
        : [];
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
        ...catalog.functions.filter(
          (name) => command !== "let" || !["sum", "mean"].includes(name),
        ),
        ...(site.option === "y" && site.table
          ? columns(snapshot, site.table, true).map((name) =>
              JSON.stringify(name),
            )
          : []),
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
        return site.option === "step" ? ["1"] : ["0", "1"];
      if (site.option === "options")
        return site.listItem ? ['"Text"'] : ['["First", "Second"]'];
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
          text: `Built-in ${raw}. Example: ${catalog.examples[raw as keyof typeof catalog.examples]}.`,
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
      text: `${raw}: directive option. ${catalog.optionDescriptions[raw as keyof typeof catalog.optionDescriptions]}`,
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
  signatureHelp,
});

/** Active calls come from the expression lexer, including unfinished buffers. */
export function signatureHelp(
  snapshot: AnalysisSnapshot,
  sourceOffset: number,
): EditorSignatureHelp | undefined {
  const parsed = snapshotSyntax(snapshot);
  if (!parsed || snapshot.identity.profile !== "tinta") return undefined;
  const call = editingSite(parsed, sourceOffset).call;
  if (!call) return undefined;
  const name = call.name as keyof typeof catalog.signatures;
  return immutable({
    label: catalog.signatures[name],
    argument: call.argument,
    example: catalog.examples[name],
  });
}
