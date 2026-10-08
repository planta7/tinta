import { parse as tokenize, postprocess, preprocess } from "micromark";
import type { SourceInput, Result, TextEdit } from "@tinta/types";
import { parse } from "./parser.js";
import { Source } from "./source.js";
import { markdown, dialect } from "./markdown.js";

/** Original token spans, including reference definitions and angle destinations. */
export function imageDestinationEdits(
  input: SourceInput,
  replacements: ReadonlyMap<string, string>,
): Result<readonly TextEdit[]> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  const source = new Source(input);
  const tree = markdown(source);
  const definitions = new Map<
    string,
    {
      start: number;
      end: number;
      url: string;
    }
  >();
  const ranges: {
    start: number;
    end: number;
    url: string;
  }[] = [];
  const references: {
    identifier: string;
    start: number;
    end: number;
  }[] = [];
  const links = new Set<string>();
  const pending = [tree as import("./markdown.js").MarkdownNode];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, {
        start: node.position!.start.offset!,
        end: node.position!.end.offset!,
        url: node.url,
      });
    if (node.type === "image")
      ranges.push({
        start: node.position!.start.offset!,
        end: node.position!.end.offset!,
        url: node.url,
      });
    if (node.type === "imageReference")
      references.push({
        identifier: node.identifier,
        start: node.position!.start.offset!,
        end: node.position!.end.offset!,
      });
    if (node.type === "linkReference") links.add(node.identifier);
    if ("children" in node)
      pending.push(
        ...(node.children as import("./markdown.js").MarkdownNode[]),
      );
  }
  for (const reference of references) {
    const definition = definitions.get(reference.identifier);
    if (definition && !links.has(reference.identifier)) ranges.push(definition);
  }
  const bom = parsed.value.source.startsWith("\ufeff") ? 1 : 0;
  const events = postprocess(
    tokenize({ extensions: dialect })
      .document()
      .write(preprocess()(parsed.value.source.slice(bom), undefined, true)),
  );
  const edits = new Map<number, TextEdit>();
  const labels = new Map<number, number>();
  const titles = new Map<number, { start: number; end: number }>();
  let definitionStart = -1;
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    if (token.type === "label")
      labels.set(token.start.offset + bom, token.end.offset + bom);
    if (token.type === "definition") definitionStart = token.start.offset + bom;
    if (token.type === "definitionTitle")
      titles.set(definitionStart, {
        start: token.start.offset + bom,
        end: token.end.offset + bom,
      });
  }
  for (const reference of references) {
    if (!links.has(reference.identifier)) continue;
    const definition = definitions.get(reference.identifier)!;
    const replacement = replacements.get(definition.url);
    if (replacement === undefined) continue;
    const labelEnd = labels.get(reference.start);
    const title = titles.get(definition.start);
    if (labelEnd === undefined) continue;
    const labelText = parsed.value.source.slice(reference.start, labelEnd);
    const titleText = title
      ? " " + parsed.value.source.slice(title.start, title.end)
      : "";
    edits.set(reference.start, {
      start: reference.start,
      end: reference.end,
      replacement: `${labelText}(${replacement}${titleText})`,
    });
  }
  ranges.sort((a, b) => a.start - b.start);
  const containing = (start: number, end: number) => {
    let low = 0,
      high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle]!.start <= start) low = middle + 1;
      else high = middle;
    }
    const candidate = ranges[low - 1];
    return candidate && end <= candidate.end ? candidate : undefined;
  };
  for (const [kind, token] of events) {
    if (
      kind !== "enter" ||
      !["resourceDestinationString", "definitionDestinationString"].includes(
        token.type,
      )
    )
      continue;
    const start = token.start.offset + bom,
      end = token.end.offset + bom;
    const range = containing(start, end);
    const replacement = range && replacements.get(range.url);
    if (replacement !== undefined)
      edits.set(start, { start, end, replacement });
  }
  return {
    ok: true,
    value: [...edits.values()].sort((a, b) => b.start - a.start),
    diagnostics: parsed.diagnostics,
  };
}
