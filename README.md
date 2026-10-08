# Tinta

**Write a document. Let the reader explore it.**

Tinta is a Markdown-first language for interactive documents. Start with familiar prose, headings and lists, then add a slider, a calculation, a conditional explanation or a chart where it helps the reader understand an idea. The text, tables and figures respond together to the reader's choices.

Use it for an explorable article, a report with shared filters, a guide that adapts to its reader, or a small model whose assumptions can be changed directly in the explanation. Source stays readable UTF-8 text in a `.tinta` file; the reference tools work with local files and produce HTML that can be opened offline.

```tinta
@meta (title: "Plan a reading session", locale: "en-US")
@let minutes_per_page = 2

# How much time should we set aside?

@slider pages = 8 (min: 1, max: 40, label: "Pages")
@toggle discussion = false (label: "Include a discussion")
@calc minutes = pages * minutes_per_page + if(discussion, 15, 0)

Reading **{{ pages }} pages** takes about **{{ minutes }} minutes**
with these choices.

@when minutes > 45
Consider dividing the reading into two sessions.
@end

@details "About this estimate"
The estimate assumes two minutes per page and fifteen minutes for discussion.
@end
```

Move the slider or enable the discussion: the total and the advice update in the same document. There is no JavaScript to write.

## Status

The repository contains the language specification, reusable packages, a command-line tool and **Tinta Studio**, the reference reader/editor. These are draft tools; contract revision **1.0-draft.2** targets source-format version **1.0**. Full release qualification, supported-platform checks and manual accessibility acceptance remain separate from passing local automated tests.

## Try it locally

From a checkout, use **Node 24.21.0** and **pnpm 10.34.6**:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Open `build/tinta-studio.html` in your browser. It is a standalone local file: no server or account is needed. Choose **Explore examples**, or open an existing `.md`, `.tinta` or `.tinta.zip` file. Documents open in Reading mode; switch to Edit to work on the source and preview.

To validate and export one of the included examples from the repository root:

```sh
pnpm --filter @tinta/cli exec tinta check examples/article.tinta
pnpm --filter @tinta/cli exec tinta build examples/article.tinta \
  --format interactive --output build/article.interactive.html
pnpm --filter @tinta/cli exec tinta build examples/article.tinta \
  --format static --output build/article.static.html
```

Open either output in a browser. Interactive HTML keeps the controls; static HTML captures the visible document with its initial answers. Existing output files require an explicit `--force` to replace them. See the [setup and toolchain guide](docs/09_FOUNDATION_TOOLCHAIN.md) for development prerequisites and the [CLI reference](docs/06_CLI.md) for commands, options, snapshots and exit codes.

## Keep Markdown at the centre

Tinta uses **CommonMark 0.31.2**, with pipe tables, task lists and double-tilde strikethrough. Headings, paragraphs, emphasis, links, lists, quotes, local images and code blocks remain the structure of the document. Code fences are literal examples; they never execute.

A `.md` file opens in Markdown mode, where Tinta directives and `{{ expressions }}` remain ordinary text. Studio's **Enrich as Tinta** action creates a separate Tinta buffer and escapes existing directive-looking text where necessary. The original Markdown file is preserved. You can also perform that conversion explicitly with `tinta enrich`.

Raw author HTML is displayed as inert text. HTML comments stay hidden in the presentation but remain in the source. Unsupported Markdown dialects such as MDX, footnotes and math are not enabled implicitly. Read the [Markdown and lexical rules](spec/01_MARKDOWN_AND_LEXING.md) for exact compatibility and escaping behaviour.

## Add controls and reactive calculations

Three native controls cover numeric, boolean and text choices:

| Directive | Reader input | Example use |
|---|---|---|
| `@slider` | A number on a bounded step grid | Quantity, rate, period or threshold |
| `@toggle` | `true` or `false` | Include an option or reveal context |
| `@choice` | One of a fixed list of text values | Platform, category or scenario |

Use `@let` for constants, `@calc` for derived values and `{{ expression }}` to place results in prose. This is a complete example:

```tinta
@meta (title: "Explore a team budget", locale: "en-US", currency: "USD")
@let monthly_price = 19
@slider people = 5 (min: 1, max: 40, label: "People")
@choice period = "monthly" (
  options: ["monthly", "annual"],
  label: "Billing period",
)
@calc total = people * monthly_price * if(period == "annual", 12, 1)

# A budget with visible assumptions

For **{{ people }} people**, the **{{ period }}** amount is **{{ money(total) }}**.
```

Expressions support strict arithmetic, comparisons and boolean operations. The eleven built-in functions are `if`, `min`, `max`, `round`, `pow`, `count`, `sum`, `mean`, `fixed`, `percent` and `money`. Formatting follows explicit document metadata, defaulting to `en-US` and `USD`.

Names and types are checked before use; cycles, implicit conversions and non-finite numeric results are rejected. Updates are transactional: if a candidate answer causes an invalid result, the previous valid document remains intact. See [expressions and state](spec/02_EXPRESSIONS_AND_STATE.md), [directive syntax](spec/03_DIRECTIVES.md) and the [all-functions example](examples/all-functions.tinta).

## Adapt the explanation

`@when condition` shows a section when its boolean condition holds. `@details "Summary"` adds a collapsible explanation. Their bodies contain ordinary Markdown and close with `@end`, so a guide can adapt without leaving the article flow.

The opening example combines both. For a longer walkthrough, the [platform guide](examples/guide.tinta) shows different instructions for macOS, Windows and Linux, plus optional context. Hidden sections are a presentation feature: their source is still included in interactive files.

## Give prose, tables and charts the same data

`@data` embeds a typed table with text, number and boolean columns. `@view` derives a filtered, optionally sorted view. Use that same view in aggregates, tables and charts so every part of the explanation refers to the same rows.

```tinta
# A fictional reading report

@slider minimum = 100 (min: 0, max: 200, step: 10, label: "Minimum readings")
@choice selected_day = "Mon" (
  options: ["Mon", "Tue", "Wed"],
  label: "Day to inspect",
)

@data activity
day:text | readings:number
Mon | 120
Tue | 160
Wed | 90
@end

@view visible = activity (where: row.readings >= minimum)
@view selected = activity (where: row.day == selected_day)

**{{ count(visible) }} days** meet the threshold, accounting for
**{{ sum(visible, "readings") }} readings**.

@chart bar visible (
  x: "day",
  y: "readings",
  select: selected_day,
  title: "Days meeting the threshold",
)

The selected day is **{{ selected_day }}**, with
**{{ sum(selected, "readings") }} readings** in the original data.

@table visible (title: "The rows shown in the chart")
```

Changing the threshold updates the count, total, figure and table. Selecting a bar updates the existing day control and the following sentence. A filter that hides the selected day does not silently reset the selection.

CSV and JSON can be imported through Studio or `tinta import-data`; their values become embedded `@data` source. There are no remote queries or live data connections. See the [data and import contract](spec/04_DATA.md) and the [complete report](examples/report.tinta).

## Explore seven chart types

| Type | Typical use |
|---|---|
| Line | Follow values across an ordered axis |
| Area | Show a series as a filled shape |
| Bar | Compare categories, including grouped series |
| Scatter | Inspect pairs of numeric values |
| Pie | Show nonnegative parts of a whole |
| Donut | Show the same relationship with a central opening |
| Histogram | Count numeric observations in bins |

Charts can use named numeric columns or a computed series involving reader controls. Compatible charts bind selection to an existing slider or choice with `select`; histograms provide inspection without selection binding. Legends change local figure visibility without changing the underlying data or totals.

Figures provide pointer inspection, keyboard exploration and a complete data table. The reader controls presentation; authors describe data and meaning rather than CSS, dimensions or event handlers. Explore the [chart atlas](examples/chart-atlas.tinta), the [chart specification](spec/05_CHARTS.md) and the [accessibility and design contract](docs/05_ACCESSIBILITY_AND_DESIGN.md).

## Choose what to save or export

| Format | Contains | Use it for |
|---|---|---|
| `.tinta` | Editable UTF-8 source and embedded table data | Authoring, reviewing changes and version control |
| `.tinta.zip` | Source plus validated local raster images | Moving a complete editable document between devices |
| Interactive HTML | Complete source, data and embedded runtime | Offline exploration with an explicit initial/current answer baseline |
| Static HTML | Resolved visible content and its referenced images | An offline reading with no executable program |
| `.tinta.state.json` | Reader answers tied to an exact source fingerprint | Explicitly saving and restoring answers |

**Interactive HTML includes hidden branches and all source data.** Hiding a section or filtering a table does not remove information from that file. Static HTML includes only the resolved visible presentation, though anything visible remains in the output. See [files, resources and exports](docs/02_FILES_AND_EXPORTS.md) for the precise boundaries.

Studio includes CodeMirror editing, diagnostics, a sandboxed preview, local data/image imports, undo and export dialogs. Optional local recovery copies are **off by default** and distinct from saved source files. Reader answers are not automatically persisted. See the [editor and reader guide](docs/03_EDITOR_AND_READER.md).

## Example documents

Each example is readable source you can open in Studio or validate with the CLI:

- [Minimal document](examples/minimal.tinta): the smallest starting point.
- [Explorable article](examples/article.tinta): prose, assumptions and a linked figure.
- [Filtered report](examples/report.tinta): shared views, totals, tables and charts.
- [Adaptive guide](examples/guide.tinta): conditional instructions and optional context.
- [Chart atlas](examples/chart-atlas.tinta): all seven figure types in one document.
- [Local image](examples/local-image.tinta): a local raster resource, also available as a [source bundle](examples/local-image.tinta.zip).

The [example index](examples/README.md) also covers Markdown enrichment and function examples. Keep the [syntax cheatsheet](docs/CHEATSHEET.md) nearby while writing.

## Build on the reusable packages

The parser and semantic engine are portable TypeScript, independent of browser UI and Node filesystem APIs. The reader and exported runtime do not depend on React or CodeMirror; those belong to the reference editor.

| Area | Read more |
|---|---|
| Parsing and explicit Markdown enrichment | [Syntax API](docs/10_SYNTAX_API.md) |
| Compilation, evaluation, sessions and imports | [Engine API](docs/11_ENGINE_API.md) |
| Safe rendering, controls, charts and lifecycle | [Reader API](docs/12_READER_API.md) |
| Package responsibilities and dependency boundaries | [Module architecture](architecture/MODULES.md) and [selected stack](architecture/STACK.md) |
| Public interfaces and serialized envelopes | [Contract rules](contracts/CONTRACT_RULES.md), [public types](contracts/public-api.d.ts) and [bundle schema](schemas/bundle.schema.json) |
| Semantics, defaults, limits and diagnostics | [Language overview](spec/00_OVERVIEW.md), [registry](spec/registry.json) and [diagnostic rules](spec/06_LIMITS_AND_DIAGNOSTICS.md) |

## Safety and project scope

Tinta evaluates a bounded expression language and renders typed safe content. Documents cannot execute author JavaScript, CSS, HTML, plug-ins or code fences, fetch remote resources, or submit forms. Local image and file access pass through explicit capability boundaries.

The project focuses on interactive documents. It does not include page-layout primitives, website generation, hosting, publication, accounts, cloud storage, collaboration, telemetry or AI features. PDF and flattened Markdown exports are outside the current scope. The [product scope](docs/01_PRODUCT.md), [decision register](DECISIONS.md) and [security model](docs/04_SECURITY.md) explain these choices; [SECURITY.md](SECURITY.md) covers reporting security issues.

## Contribute and verify

Read [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](docs/ROADMAP.md) and the [change-control policy](docs/08_CHANGE_CONTROL.md) before proposing changes to the language or its contracts.

For automated workspace verification, install the pinned browser builds and run:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm verify
```

`pnpm verify` runs the infrastructure aggregate, including formatting, lint, types, builds, unit tests, infrastructure browser checks and dependency checks. The broader `pnpm verify --suite editing` gate adds document-tooling and editor checks. Neither command alone establishes release qualification or manual accessibility acceptance. Dependency auditing needs access to the npm advisory service.

The specification consistency checks can also run with Python's standard library:

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
```

See [verification and acceptance](docs/07_VERIFICATION.md), [conformance fixtures](conformance/README.md) and [checker prerequisites](scripts/README.md) for coverage and limitations.

## License

[MIT](LICENSE). Third-party material retains its own notices and licenses. `Tinta`, `tinta` and `@tinta/*` are internal identifiers; no registered name or public namespace ownership is claimed.
