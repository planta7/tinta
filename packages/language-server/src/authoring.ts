import {
  preparePreview,
  type PreviewCompilation,
  completion,
  catalog,
  functionExample,
  definition,
  help,
  references,
  signatureHelp,
} from "@tinta/language-service";
import type { Span } from "@tinta/types";
import type { SourceIdentity, AnalysisSnapshot } from "@tinta/types/editor";
import type {
  CompletionItem,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  Range,
  SignatureHelp,
} from "vscode-languageserver/node";
import { lineStarts, position } from "./presentation.js";

export interface AuthoringQuery {
  readonly kind:
    | "completion"
    | "hover"
    | "signature"
    | "definition"
    | "references"
    | "symbols"
    | "preview";
  readonly preview?: {
    readonly identity: SourceIdentity;
    readonly text: string;
  };
  readonly position?: Position;
  readonly includeDeclaration?: boolean;
}

export type AuthoringResult =
  | PreviewCompilation
  | CompletionItem[]
  | DocumentSymbol[]
  | Location[]
  | Hover
  | SignatureHelp
  | null;

/** Supplied text only. The caller runs this inside the supervised worker. */
export function authoring(
  snapshot: AnalysisSnapshot,
  query: AuthoringQuery,
): AuthoringResult {
  if (query.kind === "preview")
    return query.preview
      ? preparePreview(query.preview.identity, query.preview.text)
      : null;
  const text = snapshot.sourceText;
  const starts = lineStarts(text);
  const range = (span: Span): Range => ({
    start: position(text, starts, span.start.offset),
    end: position(text, starts, span.end.offset),
  });
  const location = (span: Span): Location => ({
    uri: snapshot.identity.uri,
    range: range(span),
  });
  if (query.kind === "symbols") {
    return snapshot.symbols
      .filter((symbol) => symbol.kind !== "column")
      .map((symbol) => ({
        name: symbol.name || "Heading",
        kind:
          symbol.kind === "heading" ? 15 : symbol.kind === "constant" ? 14 : 13,
        range: range(symbol.extent),
        selectionRange: range(symbol.selection),
      }));
  }
  const point = query.position;
  if (
    !point ||
    !Number.isSafeInteger(point.line) ||
    !Number.isSafeInteger(point.character) ||
    point.line < 0 ||
    point.character < 0 ||
    point.line >= starts.length
  )
    return null;
  const offset = starts[point.line]! + point.character;
  const mapped = position(text, starts, offset);
  if (mapped.line !== point.line || mapped.character !== point.character)
    return null;

  if (query.kind === "completion") {
    const context = completion(snapshot, offset);
    const replacement = range(context.replacement);
    const suffix = text.slice(context.replacement.end.offset);
    const items: CompletionItem[] = [];
    for (const name of context.allowedNames) {
      const isFunction =
        context.kind === "expression" &&
        (catalog.functions as readonly string[]).includes(name);
      const example =
        isFunction && !/^\s*\(/.test(suffix)
          ? functionExample(snapshot, name)
          : name;
      if (example === undefined) continue;
      items.push({
        label: name,
        kind: isFunction
          ? 3
          : context.kind === "directive"
            ? 14
            : context.kind === "option"
              ? 10
              : 6,
        textEdit: {
          range: replacement,
          newText:
            context.kind === "option" && !/^\s*:/.test(suffix)
              ? `${name}: `
              : example,
        },
      });
    }
    if (context.kind === "directive" && /^[\t ]*(?:\r?\n|\r|$)/.test(suffix)) {
      for (const name of context.allowedNames) {
        const example = directiveExample(
          snapshot,
          name,
          context.allowedNames.includes("data"),
        );
        if (example)
          items.push({
            label: `${name} example`,
            filterText: name,
            kind: 15,
            detail: "Complete example (plain text)",
            textEdit: { range: replacement, newText: example },
            insertTextFormat: 1,
          });
      }
    }
    return items;
  }
  if (query.kind === "hover") {
    const info = help(snapshot, offset);
    return info
      ? {
          contents: {
            kind: "plaintext",
            value: [info.text, ...info.signatures].join("\n"),
          },
          range: range(info.span),
        }
      : null;
  }
  if (query.kind === "signature") {
    const info = signatureHelp(snapshot, offset);
    if (!info) return null;
    const argumentsText = info.label.slice(
      info.label.indexOf("(") + 1,
      info.label.indexOf(")"),
    );
    const parameters = argumentsText.split(", ").map((label) => ({ label }));
    return {
      signatures: [
        {
          label: info.label,
          documentation: {
            kind: "plaintext",
            value: `Example: ${info.example}`,
          },
          parameters,
        },
      ],
      activeSignature: 0,
      activeParameter: Math.min(info.argument, parameters.length - 1),
    };
  }
  if (query.kind === "definition") {
    const target = definition(snapshot, offset);
    return target ? [location(target)] : [];
  }
  const reference = snapshot.references.find(
    (item) => item.span.start.offset <= offset && offset < item.span.end.offset,
  );
  const symbol = reference
    ? snapshot.symbols.find((item) => item.id === reference.target)
    : snapshot.symbols.find(
        (item) =>
          item.kind !== "heading" &&
          item.kind !== "column" &&
          item.selection.start.offset <= offset &&
          offset < item.selection.end.offset,
      );
  if (!symbol || snapshot.completeness !== "semantic") return [];
  return [
    ...(query.includeDeclaration ? [symbol.selection] : []),
    ...references(snapshot, symbol.id),
  ].map(location);
}

function directiveExample(
  snapshot: AnalysisSnapshot,
  directive: string,
  root: boolean,
): string | undefined {
  const used = new Set(snapshot.symbols.map((symbol) => symbol.name));
  let name = "example";
  for (let index = 2; used.has(name); index++) name = `example${index}`;
  const examples: Record<string, string> = {
    meta: 'meta (version: "1.0", title: "Reading notes")',
    let: `let ${name} = 1`,
    calc: `calc ${name} = 1 + 2`,
    slider: `slider ${name} = 5 (min: 0, max: 10, step: 1, label: "Amount")`,
    toggle: `toggle ${name} = true (label: "Include details")`,
    choice: `choice ${name} = "First" (options: ["First", "Second"], label: "Selection")`,
    when: "when true\nText.\n@end",
    details: 'details "More information"\nText.\n@end',
    data: `data ${name}\nvalue:number\n1\n@end`,
  };
  if (Object.hasOwn(examples, directive)) return examples[directive];
  const table = snapshot.symbols.find(
    (symbol) => symbol.type?.kind === "table",
  );
  if (!table || table.type?.kind !== "table") {
    if (!root) return undefined;
    const data = `data ${name}\nvalue:number\n1\n@end\n`;
    if (directive === "table") return `${data}@table ${name}`;
    if (directive === "chart")
      return `${data}@chart histogram ${name} (x: "value")`;
    if (directive === "view") {
      let view = `${name}_view`;
      for (let index = 2; used.has(view); index++)
        view = `${name}_view${index}`;
      return `${data}@view ${view} = ${name}`;
    }
    return undefined;
  }
  if (directive === "view") return `view ${name} = ${table.name}`;
  if (directive === "table") return `table ${table.name} (title: "Values")`;
  const numeric = table.type.columns.find((column) => column.type === "number");
  if (directive === "chart" && numeric)
    return `chart histogram ${table.name} (x: ${JSON.stringify(numeric.name)}, bins: 8)`;
  return undefined;
}
