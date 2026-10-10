import type { Diagnostic, Span } from "@tinta/types";
import type { AnalysisSnapshot } from "@tinta/types/editor";
import type {
  Diagnostic as LspDiagnostic,
  Range,
} from "vscode-languageserver/node";

export const tokenTypes = [
  "keyword",
  "variable",
  "property",
  "parameter",
  "string",
  "function",
];
const tokenIndexes = {
  directive: 0,
  declaration: 1,
  reference: 1,
  column: 2,
  option: 3,
  literal: 4,
  function: 5,
} as const;

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    else if (text[index] !== "\r" && text[index] !== "\n") continue;
    starts.push(index + 1);
  }
  return starts;
}

export function position(
  text: string,
  starts: readonly number[],
  offset: number,
) {
  const bounded = Math.min(text.length, Math.max(0, offset));
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= bounded) low = middle;
    else high = middle;
  }
  let end = starts[low + 1] ?? text.length;
  while (end > starts[low]! && /[\r\n]/.test(text[end - 1]!)) end--;
  return { line: low, character: Math.min(bounded, end) - starts[low]! };
}

export function diagnosticPresentation(
  text: string,
  items: readonly Diagnostic[],
): LspDiagnostic[] {
  const starts = lineStarts(text);
  const range = (span: Span): Range => ({
    start: position(text, starts, span.start.offset),
    end: position(text, starts, span.end.offset),
  });
  return items.map((item) => ({
    range: range(item.span),
    severity: item.severity === "error" ? 1 : 2,
    code: item.code,
    source: "tinta",
    message: item.message,
    ...(item.related
      ? {
          relatedInformation: item.related.map((related) => ({
            location: { uri: related.span.uri, range: range(related.span) },
            message: related.message,
          })),
        }
      : {}),
  }));
}

export function semanticTokens(snapshot: AnalysisSnapshot): number[] {
  const text = snapshot.sourceText;
  const starts = lineStarts(text);
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  let previousEnd = 0;
  for (const token of snapshot.tokens) {
    // Never emit overlaps; multiline literals are split at physical line endings.
    let offset = Math.max(previousEnd, token.span.start.offset);
    const end = token.span.end.offset;
    while (offset < end) {
      const start = position(text, starts, offset);
      const next = starts[start.line + 1] ?? text.length;
      let stop = Math.min(end, next);
      while (stop > offset && /[\r\n]/.test(text[stop - 1]!)) stop--;
      if (stop > offset) {
        data.push(
          start.line - previousLine,
          start.line === previousLine
            ? start.character - previousCharacter
            : start.character,
          stop - offset,
          tokenIndexes[token.kind],
          0,
        );
        previousLine = start.line;
        previousCharacter = start.character;
      }
      offset = Math.max(stop, next);
    }
    previousEnd = Math.max(previousEnd, end);
  }
  return data;
}

export function foldingRanges(snapshot: AnalysisSnapshot) {
  const starts = lineStarts(snapshot.sourceText);
  const stack: number[] = [];
  const ranges: { startLine: number; endLine: number }[] = [];
  for (const token of snapshot.tokens) {
    if (token.kind !== "directive") continue;
    const name = snapshot.sourceText.slice(
      token.span.start.offset,
      token.span.end.offset,
    );
    const line = position(
      snapshot.sourceText,
      starts,
      token.span.start.offset,
    ).line;
    if (["@when", "@details", "@data"].includes(name)) stack.push(line);
    else if (name === "@end") {
      const start = stack.pop();
      if (start !== undefined && line > start)
        ranges.push({ startLine: start, endLine: line });
    }
  }
  const headings = snapshot.symbols.filter(
    (symbol) => symbol.kind === "heading",
  );
  for (let index = 0; index < headings.length; index++) {
    const startLine = position(
      snapshot.sourceText,
      starts,
      headings[index]!.selection.start.offset,
    ).line;
    const next = headings[index + 1];
    const endLine = next
      ? position(snapshot.sourceText, starts, next.selection.start.offset)
          .line - 1
      : starts.length - 1;
    if (endLine > startLine) ranges.push({ startLine, endLine });
  }
  return ranges.sort((a, b) => a.startLine - b.startLine);
}
