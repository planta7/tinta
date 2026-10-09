import { createSession } from "@tinta/engine";
import { CompilerHost } from "./compiler-host.js";
import { PreviewHost } from "./preview-host.js";
import { workerCode } from "./studio-runtime.js";
import { createElement as h, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { dialog, node } from "./dialogs.js";

interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  category: string;
  source: string;
}

const examples: Record<string, [string, string]> = {
  guide: [
    "Learn by doing",
    "A hands-on guide to controls, conditional explanations, and calculations. Change your platform and explore how the document responds.",
  ],
  article: [
    "An article you can explore",
    "A reading-first example where controls and formulas turn an explanation into something you can experiment with.",
  ],
  report: [
    "From data to a story",
    "Explore a local dataset through tables, calculated summaries, and charts. A starting point for an interactive report.",
  ],
  "chart-atlas": [
    "Seven ways to see your data",
    "Compare all seven supported chart types and try their accessible interactions, legends, and linked selections.",
  ],
};

const snippets: Record<string, [string, string, string]> = {
  "@meta": [
    "Document settings",
    "Set the title, language version, locale, and currency. This declaration does not add a visible block.",
    "Structure",
  ],
  "@let": [
    "A named value",
    "Define a reusable value for expressions elsewhere in your document.",
    "Calculations",
  ],
  "@calc": [
    "A live calculation",
    "Define a derived value that updates when its dependencies change.",
    "Calculations",
  ],
  "@slider": [
    "A number to explore",
    "Let the reader adjust a number within a bounded range. Use its value in text, formulas, and charts.",
    "Controls",
  ],
  "@toggle": [
    "An on/off choice",
    "Add a labelled boolean control. Pair it with a condition to reveal an explanation.",
    "Controls",
  ],
  "@choice": [
    "A set of options",
    "Let the reader choose one value from a fixed list of named options.",
    "Controls",
  ],
  "@when": [
    "A conditional passage",
    "Show the enclosed content only when the expression is true.",
    "Structure",
  ],
  "@details": [
    "An optional explanation",
    "Place supporting text inside an expandable, labelled disclosure.",
    "Structure",
  ],
  "@data": [
    "A local dataset",
    "Embed a small typed table in the source. Data stays local and is available to views and figures.",
    "Data",
  ],
  "@view": [
    "A filtered dataset",
    "Create a view of a dataset using a row condition. Includes starter data so the snippet is complete.",
    "Data",
  ],
  "@table": [
    "A visible table",
    "Present a dataset as a readable table with a title. Includes a small starter dataset.",
    "Data",
  ],
  "@chart": [
    "A chart in your document",
    "Insert a line chart backed by local starter data. Edit its fields and title in the source.",
    "Data",
  ],
  if: [
    "Choose a result",
    "Return one of two values depending on a condition.",
    "Calculations",
  ],
  min: [
    "The smaller value",
    "Return the minimum of two numbers.",
    "Calculations",
  ],
  max: [
    "The larger value",
    "Return the maximum of two numbers.",
    "Calculations",
  ],
  round: [
    "Round a number",
    "Round a numeric expression to the nearest integer.",
    "Calculations",
  ],
  pow: [
    "Raise to a power",
    "Calculate a number raised to a numeric power.",
    "Calculations",
  ],
  count: [
    "Count the rows",
    "Count rows in a dataset or filtered view. Includes starter data.",
    "Data",
  ],
  sum: [
    "Add up a column",
    "Sum a numeric column in a dataset or view. Includes starter data.",
    "Data",
  ],
  mean: [
    "Find the average",
    "Calculate the mean of a numeric column. Includes starter data.",
    "Data",
  ],
  fixed: [
    "Decimal places",
    "Format a number with a specified number of decimal places.",
    "Formatting",
  ],
  percent: [
    "A readable percentage",
    "Format a proportion as a percentage using the document locale.",
    "Formatting",
  ],
  money: [
    "A currency amount",
    "Format a number using the document currency and locale.",
    "Formatting",
  ],
};

function previewSource(entry: CatalogEntry): string {
  const context: Record<string, string> = {
    "@meta":
      "# Your document\n\nAn amount in your chosen currency: **{{ money(10) }}**.",
    "@let": "A reusable value: **{{ value }}**.",
    "@calc": "The calculated total is **{{ total }}**.",
    "@data": '@table values (title: "Local data")',
    "@view": '@table filtered (title: "Filtered rows")',
  };
  return (
    entry.source + (context[entry.name] ? "\n\n" + context[entry.name] : "")
  );
}

function DocumentThumbnail({
  source,
  name,
  compact,
}: {
  source: string;
  name: string;
  compact: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    let preview: PreviewHost | undefined;
    const compiler = new CompilerHost(workerCode, (result) => {
      if (!result.program || !mount.current) return;
      const session = createSession(result.program);
      if (!session.ok) return;
      preview = new PreviewHost(
        mount.current,
        result.program,
        new Map(),
        session.value.getRevision().state,
        1,
        () => {},
        () => {},
      );
      preview.frame.title = "Rendered thumbnail: " + name;
      preview.frame.tabIndex = -1;
      preview.frame.setAttribute("aria-hidden", "true");
      session.value.destroy();
    });
    // Compile only visible cards; filtering and closing release all resources.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        compiler.compile(source, "tinta", 1);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      compiler.stop();
      preview?.destroy();
    };
  }, [source, name]);
  return h("div", {
    className:
      "catalog-thumbnail" + (compact ? " catalog-thumbnail-compact" : ""),
    ref: mount,
    inert: true,
    "aria-hidden": true,
  });
}

function CatalogCard({
  entry,
  choose,
  kind,
}: {
  entry: CatalogEntry;
  choose: (name: string, source: string) => void;
  kind: "examples" | "snippets";
}) {
  return h(
    "article",
    { className: "catalog-card" },
    h(
      "div",
      {
        className: "catalog-sample",
        role: "img",
        "aria-label": "Rendered preview of " + entry.title,
      },
      h(DocumentThumbnail, {
        source: kind === "examples" ? entry.source : previewSource(entry),
        name: entry.name,
        compact: kind === "snippets",
      }),
    ),
    h(
      "div",
      { className: "catalog-copy" },
      h("span", { className: "catalog-category" }, entry.category),
      h("h3", null, entry.title),
      h("p", null, entry.description),
      h(
        "button",
        {
          type: "button",
          "aria-label": entry.name,
          onClick: () => choose(entry.name, entry.source),
        },
        kind === "examples" ? "Open " + entry.name : "Insert " + entry.name,
      ),
    ),
  );
}

function Catalog({
  entries,
  kind,
  choose,
}: {
  entries: CatalogEntry[];
  kind: "examples" | "snippets";
  choose: (name: string, source: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const categories = [
    "All",
    ...new Set(entries.map((entry) => entry.category)),
  ];
  const visible = entries.filter(
    (entry) =>
      (category === "All" || entry.category === category) &&
      [entry.name, entry.title, entry.description]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return h(
    "div",
    { className: "catalog catalog-" + kind },
    h(
      "div",
      { className: "catalog-filters" },
      h("input", {
        type: "search",
        "aria-label": "Search " + kind,
        placeholder: "Find your starting point…",
        value: query,
        onChange: (event) => setQuery(event.currentTarget.value),
      }),
      categories.length > 2
        ? h(
            "select",
            {
              "aria-label": "Category",
              value: category,
              onChange: (event: { currentTarget: HTMLSelectElement }) =>
                setCategory(event.currentTarget.value),
            },
            categories.map((name) => h("option", { key: name }, name)),
          )
        : null,
    ),
    h(
      "p",
      { className: "catalog-count", role: "status" },
      `${visible.length} ${kind}`,
    ),
    visible.length
      ? h(
          "div",
          { className: "catalog-grid" },
          visible.map((entry) =>
            h(CatalogCard, { key: entry.name, entry, choose, kind }),
          ),
        )
      : h(
          "p",
          { className: "catalog-empty" },
          "No matches. Try another word or category.",
        ),
  );
}

export function catalogDialog(
  kind: "examples" | "snippets",
  sources: Record<string, string>,
  choose: (name: string, source: string) => void,
  closed: () => void,
): void {
  const entries = Object.entries(sources).map(([name, source]) => {
    const data = kind === "examples" ? examples[name]! : snippets[name]!;
    return {
      name,
      source,
      title: data[0],
      description: data[1],
      category: data[2] ?? "Example",
    };
  });
  dialog(
    kind === "examples" ? "Explore examples" : "Insert tinta snippet",
    (body, close) => {
      body.classList.add("catalog-dialog");
      body.append(
        node(
          "p",
          kind === "examples"
            ? "Four complete documents. Explore an idea, read its source, and make it your own."
            : "Small building blocks, shown in action. Declaration previews include a usage example; only the original snippet is inserted.",
        ),
      );
      const mount = node("div");
      body.append(mount);
      const root = createRoot(mount);
      root.render(
        h(Catalog, {
          entries,
          kind,
          choose: (name, source) => {
            if (kind === "snippets") {
              choose(name, source);
              close();
            } else {
              close();
              choose(name, source);
            }
          },
        }),
      );
      body.addEventListener(
        "dispose",
        () => {
          root.unmount();
          closed();
        },
        { once: true },
      );
    },
  );
}
