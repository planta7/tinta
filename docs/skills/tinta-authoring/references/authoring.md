# Authoring reference

This portable subset targets tinta source format 1.0, contract 1.0-draft.3. The examples beside this reference are complete documents. For options outside this subset, consult the matching release's `docs/CHEATSHEET.md`, `spec/`, and `docs/06_CLI.md` in a tinta checkout. Do not infer syntax from another language.

## Text and declarations

Use CommonMark with pipe tables, task lists, and double-tilde strikethrough. Raw HTML is inert; HTML comments are hidden notes, still present in source. There is no YAML front matter interpretation. Optional `@meta` precedes content. Directives start in column 1, outside code, lists, quotes, and raw HTML regions.

```tinta
@meta (title: "Reading time", locale: "en-US")
@let minutes_per_page = 2

# Reading time

@slider pages = 8 (min: 1, max: 40, step: 1, label: "Pages")
@toggle discussion = false (label: "Include discussion")
@calc minutes = pages * minutes_per_page + if(discussion, 15, 0)

Allow **{{ minutes }} minutes**.

@when minutes > 45
Consider two sessions.
@end
```

Names are unique and document-global. `@let` depends only on constants; `@calc` may depend on controls and calculations. Cycles are errors. Root declarations (`@meta`, `@let`, `@calc`, `@data`, `@view`) cannot go inside conditional or details bodies. There are no author functions, loops, assignments, modules, or includes.

Control defaults and options are static literals, not formulas. Slider initial values must be on the exact decimal min/step grid and within min/max. Choice options are distinct strings and include the default. Labels must not be blank.

```tinta
@choice platform = "macOS" (
  options: ["macOS", "Windows", "Linux"],
  label: "Platform",
)

@when platform == "macOS"
Follow the macOS instructions.
@end

@when platform != "macOS"
Follow the instructions for your selected platform.
@end

@details "Why choose a platform?"
Only the relevant instructions are shown.
@end
```

There is no `@else`. Use a separate complementary `@when`. Close each block with `@end`. Option lists use commas. Parentheses or brackets allow multiline options; strings and `{{ expression }}` cannot span physical lines.

## Expressions

Use numbers, strings, booleans, names, arithmetic, comparisons, and `and`, `or`, `not`. The functions are `if`, `min`, `max`, `pow`, `round`, `fixed`, `percent`, `money`, `sum`, `mean`, and `count`. Examples:

```tinta
@calc total = pages * minutes_per_page
@calc average = if(count(visible) > 0, mean(visible, "minutes"), 0)
```

These two lines illustrate expressions in a document that declares their inputs; they are not a standalone document. `if` evaluates only its selected branch, but both branches must type-check. Guard division by zero and empty `mean` explicitly. Calculations and views are eager even when only mentioned in hidden content.

`{{ expression }}` produces text, not new Markdown or HTML. Use it in prose, not link/image destinations, code, metadata, or labels. Use `\{{ literal }}` for literal braces and `\@when literal` for directive-looking prose at column 1. Code fences are literal; never execute their contents to render the document.

## Embedded data and views

```tinta
@data reviews
chapter:text | minutes:number | approved:boolean
Setup | 12 | true
"Editing | advanced" | 18 | false
@end

@view visible = reviews (where: row.approved, sort: "minutes")
@table visible (title: "Approved chapters")
@chart bar visible (x: "chapter", y: "minutes", title: "Review time")
```

Data headers use `name:type` with exactly `text`, `number`, or `boolean`. No outer bars or Markdown separator row. Rows have the exact column count. Quote text containing `|` as a JSON string; use `""` for empty text. Numbers and booleans are unquoted literals. No nulls, nested objects, formulas, or mixed types. View filters access fields with `row.field`; aggregates refer to a column by its string name. Reuse the same view in prose, charts, and tables to keep them aligned. Do not display a zero average as a measured value when no rows match: show an explicit empty-state explanation.

Charts support line, area, bar, scatter, pie, donut, and histogram, each with its own options and data requirements. Use the bar example for simple comparisons; consult the matching chart specification for other types. There is no arbitrary chart grammar, dashboard layout, or author styling.

## Local files and exports

Local PNG, JPEG, and WebP images are supported. Remote images/data are not fetched. `tinta import-data INPUT.csv --name reviews --output imported.tinta --json` creates one standalone data declaration; inspect its column mapping and types before inserting it at a root boundary. JSON accepts arrays of flat objects with matching scalar schemas. Imports embed values; they do not stay connected to the file.

`check --with-assets` validates even hidden images. Without it, successful checking does not imply image portability. `--asset-root` grants reads under an explicit directory; an output directory is not an input grant.

To export an existing matching answer snapshot, add `--state snapshot --snapshot ANSWERS.tinta.state.json` to `build`. The snapshot must match the source hash and all controls; do not hand-edit hashes to reuse it. Otherwise exports use initial answers, even if a separate reader has been changed.

`--json` produces `{ok, command, artifacts, diagnostics, details}`. Diagnostics include severity, code, and source locations where applicable. Exit codes are 0 success, 1 validation failure, 2 usage error, 3 IO/output conflict, 4 internal failure, and 130 interruption. Warnings alone do not fail unless checking with `--warnings-as-errors`. Do not turn an IO failure into a document rewrite.
