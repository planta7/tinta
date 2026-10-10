# Complete directive contract

Option keys are case-sensitive. Only listed keys are accepted. Option lists use `(key: value, ...)` with optional trailing comma. Unless specifically described as an expression or binding, each option is a literal of the declared type, not a name, interpolation or computed value. All labels/titles are plain static text. Default labels replace `_` in a name with spaces; they do not automatically translate or capitalize it.

## `@meta`

```tinta
@meta (version: "1.0", title: "Reading notes", locale: "en-US", currency: "USD")
```

Zero or one per document, root only, before any nonblank/non-comment node. Each of version/title/locale/currency is optional. Version defaults `1.0`; title defaults the first root heading's literal text without interpolations, else `Untitled document`; locale defaults `en-US`; currency defaults `USD`. At most 200 characters in metadata title. Supported locales: en-US, en-GB, es-ES, fr-FR, de-DE, ja-JP, zh-CN, zh-TW. Supported currencies: USD, EUR, GBP, JPY, CHF, CAD, AUD, CNY. Unsupported values are `E_META_VALUE`. UI remains English regardless of locale. No arbitrary metadata keys or YAML/TOML front matter interpretation.

## `@let` and `@calc`

```tinta
@let unit_price = 19
@let annual_months = 12
@let yearly_price = unit_price * annual_months
@calc total = people * unit_price
```

Syntax: `@let name = expression` and `@calc name = expression`. Required name and expression. No option group or block. Root only. Forward references and constant/derived restrictions are in the expression contract. They produce no visible block.

## `@slider`

```tinta
@slider people = 5 (min: 1, max: 40, step: 1, label: "People")
```

Required name and numeric literal initial value. Optional min/max/step numeric literals default to 0/100/1; optional label text defaults to name with underscores replaced. No dynamic min, max, step or label. Emits labelled native range control with a current-value text output; keyboard native arrows change one tick, PageUp/PageDown ten ticks (bounded), Home/End min/max. Controls are usable even when a linked chart is outside the viewport. Domain rules and precise decimal mapping are normative in the expression contract.

## `@toggle`

```tinta
@toggle include_weekends = true (label: "Include weekends")
```

Required name and boolean literal initial. Optional label only. Native checkbox with associated label; space toggles, no click-only custom switch. Its true/false value is separate from any Markdown task-list checkbox.

## `@choice`

```tinta
@choice platform = "macOS" (options: ["macOS", "Windows", "Linux"], label: "Platform")
```

Required name, text-literal initial and nonempty literal text-list `options`. Between 1 and 50 distinct options, each 1–120 Unicode code points; comparison is exact, case-sensitive, no trimming or normalization of quoted strings. Initial must be one option. Optional label only. Native single select, no free text or multiple selection. Values and visible option labels are the same; separate IDs/labels are outside V1. Options are static, not populated from tables at runtime.

## `@when`

```tinta
@when people >= 20
This explanation is relevant to a larger team.
@end
```

Required boolean expression; no option list; nonempty Markdown/Tinta flow body ending with `@end`. Allowed at root or within when/details, not inside ordinary Markdown list/quote containers. No `@else` or `@elseif`; an alternate block is another explicit complementary `@when`. Static name/type checking covers all branches. Evaluation/visibility semantics are defined separately.

## `@details`

```tinta
@details "Read the assumptions"
The figure assumes a constant rate.
@end
```

Optional text-literal summary defaults to `More information`; nonempty body. No options. Starts closed. Nested details are allowed. Opening/closing is reader presentation state, not an expression variable. A static export renders its body expanded; interactive Reset reading closes all details.

## `@data`

```tinta
@data reading
period:number | readings:number | completed:boolean
0 | 100 | false
1 | 105 | true
@end
```

Required name; no options. Root only. A required typed header and zero or more rows, closed by `@end`. Empty lines in the data body are ignored. No comments, formulas, Markdown or nested directives inside the table. Values and validation are in `spec/04_DATA.md`. Declares data without rendering it.

## `@view`

```tinta
@view visible = reading (where: row.readings >= minimum, sort: "period", descending: false)
```

Required new name and an existing table/view identifier as source; root only. Options: `where` is a row-context boolean expression (default true); `sort` is a literal existing column name (default no sorting); `descending` is a boolean literal (default false). Specifying `descending`, even false, without `sort` is `E_PROPERTY_DEPENDENCY`. No options is a legal immutable view alias. Views preserve schema, original row IDs and stable order. `sort` applies after filtering; equal keys preserve incoming order in both directions. No computed columns, projection, joins or grouping.

## `@table`

```tinta
@table visible (title: "Rows in this explanation")
```

Required table/view name; optional static text title defaults to the source name with underscores replaced. No direct where/sort options: authors create one `@view` to share the data with prose and figures. Displays all schema columns in original order, an English count (`0 rows`, `1 row`, etc.), header cells and a localized scalar value per cell. Empty state is `No rows match the current choices.` Cell values are text, not Markdown or interpolation. No cell editing, header-click sorting, pagination or hidden columns. Large tables use a bounded scroll region with a caption and header associations; export static HTML retains all permitted rows.

## `@chart`

```tinta
@chart bar visible (x: "period", y: "readings", title: "Readers by period")
```

Required type and table/view identifier. Options: required x column literal; required y except histogram; optional title, xLabel, yLabel text; optional select binding identifier; histogram-only bins integer. No size/layout/style/event/where/sort option is recognized. Use a shared view for filtering/ordering. Full data/domain, geometry, selection, empty-state and accessibility rules are in `spec/05_CHARTS.md`.

`y` is one numeric column string, a literal list of 1–6 distinct numeric-column strings, or one numeric expression evaluated in row context. A string/list form denotes columns, not a text-valued y formula. An expression cannot return text/list, and mixed column/expression lists are not allowed. A computed single series is labelled by yLabel, default `Value`; for named series, labels are column names with underscores replaced. Named y lists retain author order.

Default title: `<Type label> — <source name with underscores replaced>`, with type labels Line chart, Area chart, Bar chart, Scatter plot, Pie chart, Donut chart, Histogram. Default xLabel is the x column name with underscores replaced. Default yLabel is the sole column name, `Value` for a computed/multiseries y, and `Frequency` for histogram. Titles are never interpolated. Use the surrounding Markdown paragraph to make a reactive caption.

## Rejected layout directives

`@columns`, `@card`, `@page`, `@grid`, `@html`, `@css`, `@script`, `@button` and every unregistered command are `E_DIRECTIVE_UNKNOWN`, not fallback HTML components. The language is a document extension, not a layout or application DSL.
