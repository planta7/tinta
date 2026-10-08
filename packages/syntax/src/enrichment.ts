import { sha256 } from "@noble/hashes/sha2.js";
import type { Enrichment, Result, SourceInput, TextEdit } from "@tinta/types";
import { parse, type SyntaxNode } from "./parser.js";

/** Discard only source bookkeeping; retain all Markdown meaning and inert resource policy. */
export function markdownMeaning(node: SyntaxNode): unknown {
  return {
    kind: node.kind,
    value: node.value,
    attributes: node.attributes,
    children: node.children.map(markdownMeaning),
  };
}

export function enrichMarkdown(input: SourceInput): Result<Enrichment> {
  const before = parse({ ...input, profile: "markdown" });
  if (!before.ok) return before;

  const { source, bytes, tree } = before.value;
  const offsets = new Set<number>();

  const escaped = (at: number): boolean => {
    let backslashes = 0;
    while (at > 0 && source[--at] === "\\") backslashes++;
    return backslashes % 2 === 1;
  };

  const scan = (node: SyntaxNode): void => {
    if (
      [
        "image",
        "imageReference",
        "code",
        "inlineCode",
        "html",
        "definition",
      ].includes(node.kind)
    )
      return;
    if (node.kind === "link" && source[node.span.start.offset] === "<") return;
    if (node.kind === "text") {
      for (let at = node.span.start.offset; at < node.span.end.offset; at++) {
        if (source.startsWith("{{", at) && !escaped(at)) {
          offsets.add(at);
          at++;
        } else if (
          source[at] === "@" &&
          (at === 0 ||
            (at === 1 && source[0] === "\ufeff") ||
            /[\r\n]/.test(source[at - 1]!)) &&
          /^@[a-z][a-z0-9_]*(?=[ \t(\r\n]|$)/.test(source.slice(at))
        )
          offsets.add(at);
      }
    }
    for (const child of node.children) scan(child);
  };

  scan(tree);
  const edits: TextEdit[] = [...offsets]
    .sort((a, b) => b - a)
    .map((start) => ({
      start,
      end: start,
      replacement: "\\",
    }));

  let enriched = source;

  for (const edit of edits)
    enriched =
      enriched.slice(0, edit.start) +
      edit.replacement +
      enriched.slice(edit.end);

  const after = parse({
    uri: input.uri,
    profile: "tinta",
    text: enriched,
  });
  if (
    !after.ok ||
    JSON.stringify(markdownMeaning(tree)) !==
      JSON.stringify(markdownMeaning(after.value.tree))
  )
    return {
      ok: false,
      diagnostics: [
        {
          code: "E_IMPORT_PRESERVATION",
          severity: "error",
          phase: "parse",
          message: "Proposed escapes do not preserve Markdown meaning.",
          span: tree.span,
        },
      ],
    };

  return {
    ok: true,
    value: {
      source: enriched,
      edits,
      originalSha256: Array.from(sha256(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    },
    diagnostics: [
      ...before.diagnostics,
      ...(edits.length
        ? [
            {
              code: "W_MARKDOWN_COLLISION",
              severity: "warning" as const,
              phase: "parse" as const,
              message: "Literal Tinta-looking text needs explicit escapes.",
              span: tree.span,
            },
          ]
        : []),
    ],
  };
}
