import type {
  CompilerOptions,
  Diagnostic,
  Expr,
  Result,
  SourceInput,
  Span,
} from "@tinta/types";
import type { CompileContext } from "mdast-util-from-markdown";
import { markdown } from "./markdown.js";
import { parseDirective, type DirectiveSyntax } from "./directive.js";
import { ExpressionParser } from "./expression.js";
import { Source, SyntaxFailure } from "./source.js";

type MdNode = CompileContext["stack"][number];
export type SyntaxKind =
  MdNode["type"] | "directive" | "interpolation" | "error";

export interface SyntaxNode {
  readonly kind: SyntaxKind;
  readonly id: string;
  readonly span: Span;
  readonly children: readonly SyntaxNode[];
  readonly value?: string;
  readonly expression?: Expr;
  readonly directive?: DirectiveSyntax;
  readonly attributes?: Readonly<
    Record<
      string,
      string | number | boolean | null | readonly (string | null)[]
    >
  >;
}

export interface EditorToken {
  readonly kind: SyntaxKind | Expr["kind"];
  readonly span: Span;
}

/** Lossless syntax, deliberately distinct from a validated/typed Program. */
export interface ParsedSource {
  readonly compileOperations: number;
  readonly source: string;
  readonly bytes: Uint8Array;
  readonly tree: SyntaxNode;
  readonly tokens: readonly EditorToken[];
  readonly diagnostics: readonly Diagnostic[];
}

export function parse(
  input: SourceInput,
  options?: CompilerOptions,
): Result<ParsedSource> {
  const recovered = parseRecovering(input, options);
  if (
    !recovered.ok ||
    recovered.value.diagnostics.some((d) => d.severity === "error")
  )
    return { ok: false, diagnostics: recovered.diagnostics };
  return recovered;
}

/** Recovery retains erroneous nodes for editing; callers must inspect diagnostics. */
export function parseRecovering(
  input: SourceInput,
  options?: CompilerOptions,
): Result<ParsedSource> {
  try {
    const source = new Source(input, options);
    const ast = markdown(source);
    const tokens: EditorToken[] = [];
    const definitions = new Map<
      string,
      { url: string; title?: string | null | undefined }
    >();
    const pending: { node: MdNode; depth: number }[] = [
      { node: ast, depth: 0 },
    ];

    let markdownNodes = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      source.limit("markdownDepth", depth, node.position?.start.offset ?? 0);
      source.limit(
        "astNodes",
        ++markdownNodes,
        node.position?.start.offset ?? 0,
      );
      if (node.type === "definition" && !definitions.has(node.identifier))
        definitions.set(node.identifier, node);
      if ("children" in node)
        for (let i = node.children.length - 1; i >= 0; i--)
          pending.push({ node: node.children[i]!, depth: depth + 1 });
    }

    let nextId = 0;

    function visitExpression(expr: Expr, depth = 1): void {
      source.limit("expressionDepth", depth, expr.span.start.offset);
      tokens.push({ kind: expr.kind, span: expr.span });
      if (expr.kind === "binary") {
        visitExpression(expr.left, depth + 1);
        visitExpression(expr.right, depth + 1);
      } else if (expr.kind === "unary")
        visitExpression(expr.operand, depth + 1);
      else if (expr.kind === "call")
        expr.arguments.forEach((e) => visitExpression(e, depth + 1));
      else if (expr.kind === "list")
        expr.items.forEach((e) => visitExpression(e, depth + 1));
    }

    function convert(node: MdNode, depth: number): SyntaxNode {
      const start = node.position?.start.offset ?? 0,
        end = node.position?.end.offset ?? source.text.length;
      source.limit("markdownDepth", depth, start);
      source.charge("astNodes", start);
      source.charge("compileOperations", start);
      const id = "n" + String(++nextId).padStart(6, "0"),
        span = source.span(start, end);
      let result: SyntaxNode;
      try {
        if (
          node.data &&
          "tinta" in node.data &&
          node.data.tinta === "directive"
        ) {
          const directive = parseDirective(source, start, end);
          if (directive.expression) visitExpression(directive.expression);
          Object.values(directive.options).forEach((e) => visitExpression(e));
          result = {
            kind: "directive",
            id,
            span,
            children: [],
            directive,
          };
        } else if (
          node.data &&
          "tinta" in node.data &&
          node.data.tinta === "interpolation"
        ) {
          const raw = source.text.slice(start, end);
          if (!raw.endsWith("}}") || /[\r\n]/.test(raw))
            source.fail(
              "E_EXPRESSION_SYNTAX",
              start,
              end,
              "Interpolation needs }} on the same physical line.",
            );
          const p = new ExpressionParser(source, start + 2, end - 2),
            expression = p.parse();
          p.finish();
          visitExpression(expression);
          result = {
            kind: "interpolation",
            id,
            span,
            children: [],
            expression,
          };
        } else {
          const children =
            "children" in node
              ? node.children.map((child) => convert(child, depth + 1))
              : [];

          const attributes: Record<
            string,
            string | number | boolean | null | readonly (string | null)[]
          > = {};
          if ("depth" in node) attributes.level = node.depth;
          if ("url" in node) {
            attributes.destination = node.url;
            attributes.title = node.title ?? null;
          }
          if ("identifier" in node) attributes.identifier = node.identifier;
          if ("alt" in node) attributes.alt = node.alt ?? "";
          if ("checked" in node) attributes.checked = node.checked ?? null;
          if ("ordered" in node) {
            attributes.ordered = node.ordered ?? false;
            attributes.start = node.start ?? 1;
          }
          if ("spread" in node) attributes.spread = node.spread ?? false;
          if ("align" in node) attributes.align = node.align ?? [];
          if ("lang" in node) {
            attributes.language = node.lang ?? null;
            attributes.meta = node.meta ?? null;
          }
          if (node.type === "linkReference" || node.type === "imageReference") {
            const definition = definitions.get(node.identifier);
            if (definition) {
              attributes.destination = definition.url;
              attributes.title = definition.title ?? null;
            }
          }
          if (
            node.type === "html" &&
            !/^(?:[ \t\r\n]*<!--(?:(?!-->)[\s\S])*-->)+[ \t\r\n]*$/.test(
              node.value,
            )
          )
            source.warn(
              "W_HTML_INERT",
              start,
              end,
              "Author HTML is inert literal source.",
            );
          if (
            node.type === "text" &&
            source.text.slice(start, end).includes("\0")
          )
            source.warn(
              "W_NUL_REPLACED",
              start,
              end,
              "NUL is displayed as a replacement character.",
            );
          result = {
            kind: node.type,
            id,
            span,
            children,
            ...(Object.keys(attributes).length ? { attributes } : {}),
            ...("value" in node ? { value: node.value } : {}),
          };
        }
      } catch (error) {
        if (
          !(error instanceof SyntaxFailure) ||
          error.diagnostic.code === "E_LIMIT"
        )
          throw error;
        source.limit("diagnostics", source.diagnostics.length + 1, start);
        source.diagnostics.push(
          error.diagnostic.code === "E_BLOCK_UNCLOSED"
            ? {
                ...error.diagnostic,
                related: [
                  {
                    message: "End of input.",
                    span: source.span(source.text.length, source.text.length),
                  },
                ],
              }
            : error.diagnostic,
        );
        result = {
          kind: "error",
          id,
          span,
          children: [],
          value: source.text.slice(start, end),
        };
      }
      tokens.push({ kind: result.kind, span });
      return result;
    }

    const converted = convert(ast, 0);
    const tree = groupBlocks(source, converted);
    nextId = 0;
    const renumber = (node: SyntaxNode): SyntaxNode => ({
      ...node,
      id: "n" + String(++nextId).padStart(6, "0"),
      children: node.children.map(renumber),
    });
    const anchored = anchors(renumber(tree), source);
    tokens.sort(
      (a, b) =>
        a.span.start.offset - b.span.start.offset ||
        b.span.end.offset - a.span.end.offset,
    );

    const value = {
      compileOperations: source.compileOperations,
      source: source.text,
      bytes: source.bytes,
      tree: anchored,
      tokens,
      diagnostics: source.diagnostics,
    };
    return {
      ok: true,
      value,
      diagnostics: source.diagnostics,
    };
  } catch (error) {
    if (error instanceof SyntaxFailure)
      return { ok: false, diagnostics: [error.diagnostic] };
    throw error;
  }
}

function groupBlocks(source: Source, root: SyntaxNode): SyntaxNode {
  const children: SyntaxNode[] = [];
  const stack: { opener: SyntaxNode; children: SyntaxNode[] }[] = [];
  let seenContent = false;
  const addError = (
    code: string,
    node: SyntaxNode,
    message: string,
    eof = false,
  ): void => {
    source.limit(
      "diagnostics",
      source.diagnostics.length + 1,
      node.span.start.offset,
    );
    source.diagnostics.push({
      code,
      severity: "error",
      phase: "parse",
      message,
      span: node.span,
      ...(eof
        ? {
            related: [
              {
                message: "End of input.",
                span: source.span(source.text.length, source.text.length),
              },
            ],
          }
        : {}),
    });
  };

  const target = (): SyntaxNode[] =>
    stack[stack.length - 1]?.children ?? children;
  const hasContent = (nodes: readonly SyntaxNode[]): boolean =>
    nodes.some(
      (n) =>
        !(
          n.kind === "html" &&
          /^(?:[ \t\r\n]*<!--(?:(?!-->)[\s\S])*-->)+[ \t\r\n]*$/.test(
            n.value ?? "",
          )
        ) && n.kind !== "definition",
    );

  for (const node of root.children) {
    const command = node.directive?.name;
    if (command === "end") {
      const frame = stack.pop();
      if (!frame) {
        addError("E_BLOCK_END", node, "No open block for @end.");
        target().push({ ...node, kind: "error" });
      } else {
        if (!hasContent(frame.children))
          addError("E_BLOCK_EMPTY", frame.opener, "Block has no content.");
        target().push({
          ...frame.opener,
          span: source.span(
            frame.opener.span.start.offset,
            node.span.end.offset,
          ),
          children: frame.children,
        });
      }
      continue;
    }
    if (
      command &&
      ["meta", "let", "calc", "data", "view"].includes(command) &&
      stack.length
    )
      addError("E_DECLARATION_SCOPE", node, "Declaration is root-only.");
    if (command === "meta" && seenContent)
      addError(
        "E_META_POSITION",
        node,
        "Metadata must precede content and cannot repeat.",
      );
    if (hasContent([node])) seenContent = true;
    if (
      command &&
      ["let", "calc", "slider", "toggle", "choice", "data", "view"].includes(
        command,
      )
    )
      source.charge("declarations", node.span.start.offset);
    if (command && ["slider", "toggle", "choice"].includes(command))
      source.charge("controls", node.span.start.offset);
    if (command === "data" || command === "view")
      source.charge("tableCount", node.span.start.offset);
    if (command === "chart")
      source.charge("chartCount", node.span.start.offset);
    if (command === "when" || command === "details") {
      source.limit("tintaBlockDepth", stack.length + 1, node.span.start.offset);
      stack.push({ opener: node, children: [] });
    } else target().push(node);
  }

  while (stack.length) {
    const frame = stack.pop()!;
    addError("E_BLOCK_UNCLOSED", frame.opener, "Block needs @end.", true);
    target().push({ ...frame.opener, children: frame.children });
  }
  return {
    ...root,
    span: source.span(0, source.text.length),
    children,
  };
}

/** Parser-derived heading aliases and inert link classifications, without DOM creation. */
function anchors(root: SyntaxNode, source: Source): SyntaxNode {
  const counts = new Map<string, number>(),
    aliases = new Map<string, string>(),
    full = new Set<string>();
  const literal = (n: SyntaxNode): string =>
    n.kind === "interpolation"
      ? ""
      : (n.value ??
        (n.kind === "image" || n.kind === "imageReference"
          ? String(n.attributes?.alt ?? "")
          : n.children.map(literal).join("")));
  const headings = (node: SyntaxNode): SyntaxNode => {
    let attributes = node.attributes;
    if (node.kind === "heading") {
      const base =
        literal(node)
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-|-$/g, "") || "section";
      let count = (counts.get(base) ?? 0) + 1;
      let slug = base + (count > 1 ? "-" + count : "");
      while (full.has("tinta-" + slug)) {
        count++;
        slug = base + "-" + count;
      }
      counts.set(base, count);
      const anchor = "tinta-" + slug;
      aliases.set(slug, anchor);
      full.add(anchor);
      attributes = { ...attributes, anchor };
    }
    return {
      ...node,
      ...(attributes ? { attributes } : {}),
      children: node.children.map(headings),
    };
  };

  const withHeadings = headings(root);
  const links = (node: SyntaxNode): SyntaxNode => {
    let attributes = node.attributes;
    if (
      (node.kind === "link" || node.kind === "linkReference") &&
      typeof attributes?.destination === "string"
    ) {
      const destination = attributes.destination;
      let safe = false,
        resolved = destination;
      if (destination.startsWith("#")) {
        try {
          const decoded = decodeURIComponent(destination.slice(1));
          const match =
            aliases.get(decoded) ?? (full.has(decoded) ? decoded : undefined);
          if (match) {
            resolved = "#" + match;
            safe = true;
          }
        } catch {
          /* Invalid UTF-8 fragments stay inert. */
        }
      } else if (
        /^(?:https?:|mailto:)/i.test(destination) &&
        !Array.from(destination).some(
          (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
        )
      )
        safe = true;
      else {
        const unsafe =
          /^[\s\S]*:/.test(destination) || destination.startsWith("//");
        source.warn(
          unsafe ? "W_LINK_UNSAFE" : "W_LINK_LOCAL_UNSUPPORTED",
          node.span.start.offset,
          node.span.end.offset,
          "Link destination is inert.",
        );
      }
      attributes = {
        ...attributes,
        resolvedDestination: resolved,
        active: safe,
      };
    }
    return {
      ...node,
      ...(attributes ? { attributes } : {}),
      children: node.children.map(links),
    };
  };

  return links(withHeadings);
}
