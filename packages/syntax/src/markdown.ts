import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Extension as TreeExtension,
  Token,
} from "mdast-util-from-markdown";
import { parse as markdownParser } from "micromark";
import type { Options } from "micromark";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { Source } from "./source.js";

type Construct = Extract<
  ReturnType<typeof markdownParser>["constructs"]["flow"][number],
  { tokenize: unknown }
>;
type Tokenizer = Construct["tokenize"];
type State = Parameters<Tokenizer>[1];
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;
export type MarkdownNode = MarkdownRoot | MarkdownRoot["children"][number];
export const dialect = [
  gfmTable(),
  gfmTaskListItem(),
  gfmStrikethrough({ singleTilde: false }),
];
const directiveToken = "tintaDirective" as Token["type"];
const interpolationToken = "tintaInterpolation" as Token["type"];
const eol = (c: number | null): boolean => c === -5 || c === -4 || c === -3;

/** Called only by the Markdown flow tokenizer at a syntactically eligible boundary. */
export function directiveExtent(
  source: Source,
  start: number,
): number | undefined {
  const match = /^@([a-z][a-z0-9_]*)(?=[ \t(\r\n]|$)/.exec(
    source.text.slice(start),
  );
  if (!match) return undefined;
  let i = start + match[0].length,
    depth = 0,
    quoted = false,
    escaped = false;
  for (; i < source.text.length; i++) {
    const c = source.text[i]!;
    source.charge("compileOperations", i);
    if (c === "\r" || c === "\n") {
      if (quoted || depth <= 0) break;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(" || c === "[") {
      depth++;
      source.limit("expressionDepth", depth, i);
    } else if (c === ")" || c === "]") depth--;
  }
  if (match[1] === "data") {
    let next = i;
    while (next < source.text.length) {
      if (source.text[next] === "\r") next++;
      if (source.text[next] === "\n") next++;
      const lineStart = next;
      while (next < source.text.length && !/[\r\n]/.test(source.text[next]!))
        next++;
      if (/^@end[ \t]*$/.test(source.text.slice(lineStart, next))) return next;
    }
    return source.text.length;
  }
  return i;
}

export function markdown(
  source: Source,
  active = source.input.profile === "tinta",
  inline = true,
): MarkdownRoot {
  // Parse without the BOM and map every tokenizer/tree offset back to the original buffer.
  const bom = source.text.startsWith("\ufeff") ? 1 : 0;
  // Resolve image labels with ordinary Markdown inline rules first. Their alt
  // text must not be reinterpreted even when braces contain brackets or markup.
  const imageSpans: { start: number; end: number }[] = [];
  if (active && inline) {
    const pending = [
      markdown(
        source,
        active,
        false,
      ) as import("mdast-util-from-markdown").CompileContext["stack"][number],
    ];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "image" || node.type === "imageReference")
        imageSpans.push({
          start: node.position!.start.offset!,
          end: node.position!.end.offset!,
        });
      else if ("children" in node)
        for (const child of node.children) pending.push(child);
    }
    imageSpans.sort((a, b) => a.start - b.start);
  }
  const isImage = (offset: number): boolean => {
    let lo = 0,
      hi = imageSpans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (imageSpans[mid]!.end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return !!imageSpans[lo] && imageSpans[lo]!.start <= offset;
  };
  const extension: NonNullable<Options["extensions"]>[number] = {
    flow: {
      64: {
        name: "tintaDirective",
        concrete: true,
        tokenize: function (effects, ok, nok) {
          const at = this.now();
          if (at.column !== 1) return nok;
          const end = directiveExtent(source, at.offset + bom);
          if (end === undefined) return nok;
          const now = () => this.now();
          let chunkOpen = false;
          const chunk = "tintaChunk" as Token["type"];
          const consume: State = (code) => {
            source.charge("compileOperations", now().offset + bom);
            if (code === null || (now().offset + bom >= end && code !== -1)) {
              if (chunkOpen) effects.exit(chunk);
              effects.exit(directiveToken);
              return ok(code);
            }
            if (eol(code)) {
              if (chunkOpen) {
                effects.exit(chunk);
                chunkOpen = false;
              }
              effects.enter("lineEnding");
              effects.consume(code);
              effects.exit("lineEnding");
            } else {
              if (!chunkOpen) {
                effects.enter(chunk);
                chunkOpen = true;
              }
              effects.consume(code);
            }
            return consume;
          };
          return (code) => {
            effects.enter(directiveToken);
            return consume(code);
          };
        },
      },
    },
    text: !inline
      ? {}
      : {
          123: {
            name: "tintaInterpolation",
            tokenize: function (effects, ok, nok) {
              if (isImage(this.now().offset + bom)) return nok;
              const now = () => this.now();
              const labelStarts = this._labelStarts;
              let quoted = false,
                escaped = false,
                closing = false;
              const body: State = (code) => {
                source.charge("compileOperations", now().offset + bom);
                if (code === null || eol(code)) {
                  effects.exit(interpolationToken);
                  return ok(code);
                }
                if (!quoted && closing && code === 125) {
                  effects.consume(code);
                  effects.exit(interpolationToken);
                  return ok;
                }
                closing = !quoted && code === 125;
                if (quoted) {
                  if (escaped) escaped = false;
                  else if (code === 92) escaped = true;
                  else if (code === 34) quoted = false;
                } else if (code === 34) quoted = true;
                effects.consume(code);
                return body;
              };
              const second: State = (code) => {
                if (code !== 123) return nok(code);
                // An interpolation cannot turn an otherwise invalid image label
                // into an image by shielding its closing brackets.
                for (const label of labelStarts ?? [])
                  if (label.type === "labelImage") label._inactive = true;
                effects.consume(code);
                return body;
              };
              return (code) => {
                effects.enter(interpolationToken);
                effects.consume(code);
                return second;
              };
            },
          },
        },
  };
  const treeExtension: TreeExtension = {
    enter: {
      tintaDirective(token) {
        this.enter(
          {
            type: "code",
            value: "",
            data: { tinta: "directive" },
          },
          token,
        );
      },

      tintaInterpolation(token) {
        this.enter(
          {
            type: "inlineCode",
            value: "",
            data: { tinta: "interpolation" },
          },
          token,
        );
      },
    },
    exit: {
      tintaDirective(token) {
        const node = this.stack[this.stack.length - 1];
        if (node?.type === "code") node.value = this.sliceSerialize(token);
        this.exit(token);
      },

      tintaInterpolation(token) {
        const node = this.stack[this.stack.length - 1];
        if (node?.type === "inlineCode")
          node.value = this.sliceSerialize(token);
        this.exit(token);
      },
    },
  };
  const settings = {
    observeTokenizer(
      event: string,
      offset: number,
      type?: string,
      stack?: readonly { type: string }[],
    ): void {
      if (event === "transition")
        source.charge("compileOperations", offset + bom);
      else if (
        type === "blockQuote" ||
        type === "listOrdered" ||
        type === "listUnordered"
      ) {
        const depth =
          (stack ?? []).filter((t) =>
            ["blockQuote", "listOrdered", "listUnordered"].includes(t.type),
          ).length + 1;
        source.limit("markdownDepth", depth, offset + bom);
      }
    },
    extensions: [...dialect, ...(active ? [extension] : [])],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      ...(active ? [treeExtension] : []),
    ],
  };
  const tree = fromMarkdown(source.text.slice(bom), settings);
  const pending = [
    tree as import("mdast-util-from-markdown").CompileContext["stack"][number],
  ];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.position)
      node.position = {
        start: source.position((node.position.start.offset ?? 0) + bom),
        end: source.position((node.position.end.offset ?? 0) + bom),
      };
    if ("children" in node) pending.push(...node.children);
  }
  return tree;
}
