# tinta syntax quick reference — 1.0-draft.3

**Write a document. Add exploration only where it helps the reader.** `.tinta` is UTF-8 text. The examples below show the supported syntax for this draft contract. Normative details live in spec/; this reference does not override them.

## 1. A document with one interactive idea

```tinta
@meta (title: "A team’s reading time", locale: "en-US", currency: "USD")
@let minutes_per_page = 2

# How much time should we set aside?

@slider pages = 8 (min: 1, max: 40, label: "Pages")

Reading **{{ pages }} pages** takes about **{{ pages * minutes_per_page }} minutes**.

@when pages >= 20
Consider dividing the reading into two sessions.
@end

The explanation continues as ordinary Markdown.
```

## 2. Markdown-compatible text formatting

Headings, paragraphs, emphasis, strong text, links, local images, block quotes, nested/ordered lists, code spans/fences, reference links and thematic breaks follow CommonMark 0.31.2. Pipe tables, task lists and `~~strikethrough~~` are additionally supported. Task-list checkboxes are static, not answer controls. Raw HTML is shown inert, not executed. HTML comments are hidden but remain in source/interactive exports.

````tinta
# A familiar note

**Strong**, *emphasis*, ~~removed~~, and `literal code`.

- One point
  - A nested point

> An observation.

[An external reference](https://example.com)

<!-- Author note, not a secret. -->

```text
@slider this_is_code = 5
{{ this_is_not_evaluated }}
```
````

A `.md` file opens in Markdown mode: no tinta directives or interpolation activate. **Enrich as tinta** creates a new `.tinta` buffer and escapes existing tinta-looking text only where necessary. It does not overwrite the `.md` file or turn its template examples into running expressions.

## 3. Constants, answers and calculations

```tinta
@let rate = 19
@let annual_rate = rate * 12
@slider people = 5 (min: 1, max: 40, label: "People")
@toggle support = false (label: "Priority support")
@choice period = "monthly" (options: ["monthly", "annual"], label: "Period")
@calc subtotal = people * if(period == "annual", annual_rate, rate)
@calc total = subtotal + if(support, 49, 0)

The total is **{{ money(total) }}**.
```

`@let` may reference constants, not controls/calculations/tables. `@calc` may depend on constants, answers, calculations and allowed table aggregates. Forward references are legal; cycles are not. All names are document-global and unique. Root declarations (`let`, `calc`, `data`, `view`, `meta`) cannot be placed inside conditional or details bodies.

Control initial values and static properties are **ungrouped literals**, not formulas: use `label: "People"`, not `label: ("People")`. Numeric signs touch their number; static list items are also ungrouped. Expression parentheses remain available in calculations, conditions, filters and computed chart values. `@choice` requires distinct text options and an initial contained in them. `@slider` defaults to min 0, max 100, step 1; its min/max/step/initial must form the precisely defined decimal grid. All labels default to the name with underscores replaced by spaces. Effective control labels and details summaries cannot be blank; underscore-only control names need an explicit nonblank label. Metadata/labels/figure titles are static: use surrounding prose for dynamic captions.

## 4. Long directives can breathe

```tinta
@choice platform = "macOS" (
  options: ["macOS", "Windows", "Linux"],
  label: "Your operating system",
)
```

An open parenthesis or bracket permits a newline; strings and `{{ ... }}` cannot cross physical lines. Options use commas. There are no semicolons, author CSS, JSX or callbacks. Directives begin in physical column 1 outside Markdown code, lists, quotes and raw-HTML regions. Their content can contain normal Markdown indentation; indentation does not close tinta blocks.

## 5. Expressions in the text

```tinta
@slider quantity = 5
@toggle extra = false

Quantity: {{ quantity }}.
Double: **{{ quantity * 2 }}**.
Description: {{ if(extra, "Extra included", "No extra") }}.
```

The interpolation result is text, not fresh Markdown or HTML. Numbers/text/booleans are printable; a list/table is not. Do not interpolate in link/image destinations, code, raw HTML, metadata or option labels. Markdown visible text inside link labels and table cells is eligible under the lexical contract.

`\{{ literal }}` prints double braces. Single braces such as `{"name":"reader"}` are ordinary text. `\@when literal` prints a directive-looking line. Escapes are context-aware; they are not a global search-and-replace operation.

## 6. Types and operators

| Kind | Examples |
|---|---|
| Number | `19`, `-2.5`, `1e3` |
| Text | `"A sentence"`, `"Quote: \"yes\""` |
| Boolean | `true`, `false` |
| Homogeneous scalar list | `[1, 2, 3]`, `["short", "long"]` |
| Name | `reading_time`, `_note`, `month2` |
| Row field, only in a row context | `row.month` |

Names use ASCII letters/digits/underscore, never a leading digit. Text supports Unicode. No null, objects, nested lists, indexes, general property access, implicit coercion or user functions. Only `row.column` is field syntax.

| Operation | Forms |
|---|---|
| Arithmetic | `+`, `-`, `*`, `/`, `%`, unary `+`/`-` |
| Comparison | `<`, `<=`, `>`, `>=`, `==`, `!=` |
| Boolean | `and`, `or`, `not` |
| Grouping | `(expression)` |

Operators are strict: `+` does not join strings; `"5" == 5` is an error. `and`/`or` short-circuit; all references and types are checked even in branches that do not run. `if` evaluates only the chosen branch. Numeric results must be finite.

## 7. All eleven functions

| Function | Meaning |
|---|---|
| `if(condition, when_true, when_false)` | One lazily evaluated branch, with compatible result types. |
| `min(a, b)` | Smaller of exactly two numbers. |
| `max(a, b)` | Larger of exactly two numbers. |
| `round(n, digits = 0)` | Rounds to 0–10 fractional digits; halfway cases toward positive infinity. |
| `pow(base, exponent)` | Numeric power; a non-finite result is an error. |
| `count(list_or_table)` | Number of items/rows. |
| `sum(table_or_view, "column")` | Sum of a numeric column; empty is zero. |
| `mean(table_or_view, "column")` | Mean of a numeric column; empty is an error. |
| `fixed(n, digits)` | Locale-formatted number with exactly 0–10 fractional digits. |
| `percent(n)` | Locale percent, 0–1 fractional digits; `0.125` is `12.5%` in en-US. |
| `money(n)` | Metadata currency/locale; currency-standard fraction digits. |

Formatting functions return text. For `round` and `fixed`, `digits` is a runtime integer in range, not a global precision setting. No arbitrary currency argument or formatting pattern is available. Guard empty means explicitly: `if(count(rows) == 0, 0, mean(rows, "score"))`.

## 8. Conditional explanations and details

```tinta
@toggle show_work = false (label: "Show the calculation")

@when show_work
## The intermediate steps

1. Read the input.
2. Apply the formula.

@details "A note about the assumptions"
This example uses synthetic data.
@end
@end
```

`@when` requires boolean condition and a nonempty body. `@details` has an optional static summary and starts closed. There is no else: use another complementary `@when`, or inline `if`. Hidden conditional bodies are not evaluated, but all code is parsed/type-checked. Collapsed details are evaluated. Hiding does not protect source/data. `@end` closes the innermost tinta block, except inside Markdown literal-code regions where it is text.

## 9. Typed data, shared views and tables

```tinta
@slider minimum = 100 (min: 0, max: 300, label: "Minimum readings")

@data activity
day:text | readings:number | weekend:boolean
"Mon" | 120 | false
"Tue" | 160 | false
"Sat" | 80 | true
@end

@view visible = activity (
  where: row.readings >= minimum and not row.weekend,
  sort: "readings",
  descending: true,
)

**{{ count(visible) }} days** meet the rule.
Together they account for **{{ sum(visible, "readings") }} readings**.

@table visible (title: "The rows being discussed")
```

Table column types are `text`, `number`, `boolean`. Quoted text supports JSON escaping and may include a literal pipe without splitting the cell. Unquoted text is trimmed; quote it to preserve leading/trailing spaces. Missing numeric/boolean cells, extra cells and unknown headers are errors. Blank lines inside data are ignored; a header with zero rows is valid.

`@view` preserves columns/row IDs, filters first, then stably sorts. `where` is a row-context expression; `sort` is a literal column name; `descending` requires `sort`. A view without options aliases its input. No repeated where/sort on `@table` or `@chart`: reuse the same view for everything. Import CSV/JSON locally through the editor/CLI; imported data becomes inline `@data`, not a network connection.

## 10. The seven chart forms

Given numeric columns `month`, `readers`, `target`, `share` and a text column `category` in the indicated tables:

```tinta
@chart line trend (x: "month", y: "readers")
@chart area trend (x: "month", y: "readers")
@chart bar categories (x: "category", y: "readers")
@chart scatter trend (x: "month", y: "readers")
@chart pie categories (x: "category", y: "share")
@chart donut categories (x: "category", y: "share")
@chart histogram observations (x: "value", bins: 8)
```

These are isolated forms, not a complete runnable document; see examples/chart-atlas.tinta for complete data declarations.

Multiple named numeric series:

```tinta
@chart line trend (x: "month", y: ["readers", "target"], title: "Observed and target")
```

One computed numeric series linked to a control:

```tinta
@chart line trend (
  x: "month",
  y: row.readers * multiplier,
  yLabel: "Adjusted readings",
)
```

Chart options are `x`, `y`, `title`, `xLabel`, `yLabel`, `select`, and histogram-only `bins`. Histogram forbids `y` and `select`. No dimensions, arbitrary colours, HTML/CSS or event handlers are part of source. Figure appearance belongs to the reader; a paragraph is its explorable caption.

Line/area/bar accept text or numeric x; scatter/histogram require numeric x. Line/area numeric x is ordered ascending; bars preserve input order. All except scatter/histogram require unique x values. Areas overlap without stacking; bars are grouped. Pie/donut accept one nonnegative series; zero-total data is a documented empty figure. Histogram counts observations into equally spaced intervals and includes the maximum in the final bin.

## 11. Link a figure back to the explanation

```tinta
@choice chosen_day = "Mon" (options: ["Mon", "Tue", "Wed"], label: "Explore a day")

@data activity
day:text | readings:number
Mon | 120
Tue | 160
Wed | 145
@end

@chart bar activity (x: "day", y: "readings", select: chosen_day)
@view detail = activity (where: row.day == chosen_day)

**{{ chosen_day }}** had **{{ sum(detail, "readings") }} readings**.
```

Selecting a mark updates an existing compatible choice/slider; changing that control highlights matching marks. No implicit new state is created. A filter hiding the selection does not reset it. Chart legends temporarily hide series/categories, but never change the table, formulas or selection. Keyboard users can inspect through the figure's native range explorer, use its action button, and read its complete data table. Histogram permits inspection but no answer binding.

## 12. Metadata, files and boundaries

The complete directive set is `meta`, `let`, `calc`, `slider`, `toggle`, `choice`, `when`, `details`, `data`, `view`, `table`, `chart`; `end` is their closing delimiter. Metadata must precede everything except blank lines and comments, including Markdown link reference definitions. Metadata defaults are source version 1.0, locale en-US, currency USD and title derived from the first root heading or Untitled document. See spec/03 for the exact locale/currency allowlists.

`.tinta` stores editable text. `.tinta.zip` stores validated source and local image bytes. Interactive HTML stores the complete program and an explicit initial/current answer baseline; it works offline. Static HTML stores only a resolved visible reading, with no executable program. Snapshots use `.tinta.state.json` and are valid only for the exact source fingerprint. None of these requires a server or account.

No page layouts, cards, columns, routes, remote data, author scripting, custom functions/components, AI, form submission, publication, persistence services, PDF generator or Markdown-flattening exporter is included in V1.
