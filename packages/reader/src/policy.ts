import type { ResolvedNode } from "@tinta/types";

const tags = new Set([
  "article",
  "section",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "del",
  "hr",
  "br",
  "a",
  "table",
  "caption",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "div",
  "span",
  "input",
]);

export function safeLink(destination: string): boolean {
  return (
    /^(?:https?:|mailto:|#)/i.test(destination) &&
    ![...destination].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || code === 127;
    })
  );
}

/** Resolved attributes are a closed renderer vocabulary, never author markup. */
export function validAttribute(
  tag: string,
  name: string,
  value: unknown,
): boolean {
  if (name === "id") {
    return (
      /^h[1-6]$/.test(tag) &&
      typeof value === "string" &&
      /^tinta-[\p{L}\p{N}-]+$/u.test(value)
    );
  }
  if (tag === "a") {
    if (name === "href") return typeof value === "string" && safeLink(value);
    if (name === "title") return typeof value === "string";
  }
  if (tag === "ol" && name === "start") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  if (tag === "th" && name === "scope") return value === "col";
  if (tag === "input") {
    if (name === "type") return value === "checkbox";
    if (name === "disabled") return value === true;
    if (name === "checked") return typeof value === "boolean";
  }
  return false;
}

/** Preflight before touching the live projection, including reused controls. */
export function validateNodes(nodes: readonly ResolvedNode[]): void {
  const seen = new WeakSet<object>();
  const pending = [nodes];
  while (pending.length) {
    const items = pending.pop()!;
    if (!Array.isArray(items)) throw new Error("Invalid render tree.");
    for (const node of items) {
      if (!node || typeof node.id !== "string" || seen.has(node)) {
        throw new Error("Invalid render node.");
      }
      seen.add(node);
      switch (node.kind) {
        case "text":
          if (typeof node.value !== "string") throw new Error("Invalid text.");
          break;
        case "element":
          if (
            !tags.has(node.tag) ||
            !node.attributes ||
            Object.entries(node.attributes).some(
              ([key, value]) => !validAttribute(node.tag, key, value),
            )
          ) {
            throw new Error("Invalid renderer element or attribute.");
          }
          if (
            node.tag === "input" &&
            (node.attributes.type !== "checkbox" ||
              node.attributes.disabled !== true)
          ) {
            throw new Error("Markdown tasks must be disabled.");
          }
          pending.push(node.children);
          break;
        case "control": {
          const d = node.definition;
          if (!d || typeof d.name !== "string" || typeof d.label !== "string") {
            throw new Error("Invalid control.");
          }
          if (d.kind === "slider") {
            if (
              ![d.min, d.max, d.step, node.value].every(
                (v) => typeof v === "number" && Number.isFinite(v),
              ) ||
              d.step <= 0 ||
              d.min > d.max
            ) {
              throw new Error("Invalid slider.");
            }
          } else if (d.kind === "toggle") {
            if (typeof node.value !== "boolean")
              throw new Error("Invalid toggle.");
          } else if (d.kind === "choice") {
            if (
              !Array.isArray(d.options) ||
              !d.options.every((v: unknown) => typeof v === "string") ||
              typeof node.value !== "string" ||
              !d.options.includes(node.value)
            ) {
              throw new Error("Invalid choice.");
            }
          } else throw new Error("Unknown control.");
          break;
        }
        case "image":
          if (
            typeof node.alt !== "string" ||
            typeof node.destination !== "string"
          ) {
            throw new Error("Invalid image.");
          }
          break;
        case "chart":
          if (!node.chart || typeof node.chart.title !== "string") {
            throw new Error("Invalid chart.");
          }
          break;
        default:
          throw new Error("Unknown render node.");
      }
    }
  }
}
