# Interactive chart contract

Charts are inline figures in document flow. They consume a table/view and the document's state; they never define a page layout, arbitrary code, remote data source or independent application model. The engine prepares data; the geometry adapter derives SVG; the reader adds interaction. All seven types are required for V1.

## Shared property grammar

`@chart TYPE SOURCE (x: "column", y: Y, title: "...", xLabel: "...", yLabel: "...", select: CONTROL, bins: N)`

Only `x` is always required as an option. `y` is required for all types except histogram, which forbids it. x must be a literal column name; y may be one numeric-column literal, a literal array of 1–6 distinct numeric-column names, or one numeric row-context expression. `select` is an existing control identifier, not a string or expression. `bins` is an integer literal 2–30, histogram only, default 8. Duplicate/unknown options are errors. `where`, `sort` and `descending` are not chart properties; prepare a reusable `@view` first.

All property validation is performed at compile time where schema/static values suffice, then at preparation time for data-dependent conditions. Invisible `@when` bodies are not prepared; when made visible their data constraints must be checked before committing the control update. Collapsed details do not defer chart validation.

## Required type matrix

| Type        | x                                     | y                                         | Ordering and duplicate x                                              | Geometry                                                                | Selection                                     |
| ----------- | ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `line`      | text or number                        | 1–6 numeric series or one computed series | Numeric x ascending; text x incoming row order. Duplicate x rejected. | Straight line segments, no smoothing, dash pattern per series.          | x -> matching choice/slider                   |
| `area`      | text or number                        | As line                                   | Same as line.                                                         | Unstacked overlays filled to y=0; preserve negative values.             | As line                                       |
| `bar`       | text or number, treated as categories | 1–6 numeric series or one computed series | Incoming row order; duplicate x rejected.                             | Vertical grouped bars; baseline 0, negatives below.                     | x -> matching choice/slider                   |
| `scatter`   | number                                | 1–6 numeric series or one computed series | Incoming row order; duplicate x allowed.                              | Discrete points, no connecting path.                                    | x only; equal x select the same control value |
| `pie`       | text or number                        | One nonnegative numeric series only       | Incoming row order; duplicate x rejected.                             | Sectors in source order, clockwise from 12 o'clock; no exploded wedges. | x -> matching choice/slider                   |
| `donut`     | As pie                                | As pie                                    | As pie                                                                | Pie with inner radius 60% of outer and visible-total label.             | As pie                                        |
| `histogram` | number                                | Forbidden                                 | Observations; duplicate x allowed.                                    | Counts in equal-width computed intervals.                               | Forbidden                                     |

For pie/donut a one-element y list is legal and equivalent to a single named column. A y array with more than one item is `E_CHART_SERIES`. No stacked bars/areas, date/time axis, log scale, explicit domain, secondary axis, custom tick formatter, author colour, author dimensions, animation or zoom/pan/brush.

## Preparation and identity

Resolve the table/view in the current candidate revision. Evaluate each computed y once per input row. Preserve raw numeric values, source row IDs, column/series identity and the associated x scalar. A point ID is `<chart node ID>:<row ID>:<series index>`. An interval ID is `<chart node ID>:bin:<index>`; recomputing bins may change interval meaning, so local inspection resets on histogram-domain change.

Validate all prepared values, including a series temporarily hidden by the reader. A hidden legend item cannot make invalid input valid. Limits apply to prepared data, not just visible SVG nodes. Numerical x/series values must be finite; pie/donut values must be >=0. Data limits: at most 2000 rows per figure, 200 categories for categorical line/area/bar, 24 sectors for pie/donut, 6 series, 12000 data marks per figure and 32000 prepared data marks in one visible document revision. Histogram marks equal bins; its row limit still applies to observations. Rows in false conditional branches do not count toward visible-figure marks, but global source/table limits still apply.

For numeric line/area sort by x before constructing paths, independent of the input view's ordering. The figure table uses the prepared figure order so the explorer, graph and table agree. For scatter, source order is stable even with overlapping points. No aggregation of repeated x is automatic.

## Domains and coordinates

The semantic result includes data domains independent of viewport size. Default linear/area x numeric domain is min/max x; categorical x uses the established row order. Scatter x is a linear numeric domain. Bar x always uses a band domain of row categories, even for numeric labels. For line/scatter y use min/max of all currently legend-visible series; for area/bar include zero. If there are no visible series/categories, show the all-hidden state and keep the previous global selection unchanged.

For a constant numeric domain [v,v], expand by `max(1,abs(v)*0.05)` on each side. For area/bar with all values zero, use [-1,1]. No hidden arbitrary library `nice()` expansion. A domain span must be positive and finite after expansion; otherwise `E_CHART_DOMAIN`. Arithmetic used for geometry must remain finite. Reject pathological finite raw values that cannot generate a finite scene, rather than emit invalid SVG. Limits and errors are part of the public preparation result.

Use d3 continuous linear scales for numeric axes; point scale with padding 0.5 for categorical line/area; band scale with inner padding 0.2 and outer padding 0.1 for bars, and sub-band inner padding 0.1 for grouped series. Use straight d3 line/area curves, not interpolation selected by the dependency's default theme. Pie sort is disabled; arc pad angle is 0. No chart library may add unrequested data sorting or normalization.

Interactive layout width W is the figure content width rounded to a CSS pixel, clamped to [280,800]. Plot height H is `round(clamp(W*0.55,240,400))`. Outer SVG has that width/height; Cartesian margins are left 64, right 20, top 20, bottom 48. Pie/donut use center [W/2,H/2] and radius `min(W,H)/2-20`; legend and caption are HTML outside SVG. Numeric axes request five ticks from the locked d3-array implementation; categorical ticks show every `ceil(n/max(2,floor(plotWidth/70)))`th label and always the final category. Tick label truncation uses 14 Unicode code points plus an ellipsis; full text remains in inspection/table. Geometry snapshots are bound to the locked D3 build, semantic-domain fixtures are not.

SVG numbers are serialized with at most three fractional digits, trailing zeros removed, -0 normalized. Point radius is 4 CSS pixels with a pointer hit target radius of 12. Line width 2; area opacity 0.15. Bars remain at least 1 pixel visually; dense plots do not invent aggregation. The underlying rows and keyboard explorer still expose each datum.

Static HTML uses a fixed nominal SVG width 720 and height 396 with the same rules; on narrower screens its figure wrapper may scroll horizontally to preserve labels. Interactive charts reflow with ResizeObserver. The document itself must not acquire horizontal overflow because of a figure. A graph is allowed a two-dimensional scroll area; prose is not.

## Histogram algorithm

Use the selected input rows' x values. Empty input produces no bins and the standard empty state. For nonempty input with distinct min/max use lo=min and hi=max. If all observations equal v, use lo=v-d and hi=v+d where `d=max(0.5,abs(v)*0.05)`. Reject nonfinite/unordered bounds. For bins B, boundaries are `lo + i*(hi-lo)/B`, i=0..B, with endpoints set exactly to lo and hi. Reject nonincreasing boundaries due to floating precision.

Intervals are `[edge[i],edge[i+1])`, except the last is closed at its upper endpoint. Assign by comparing against the computed boundary array (not an independently rounded width formula). Each observation belongs to exactly one interval. Include zero-count bins. Count sum equals the number of input rows. The y domain includes 0; frequency is integer, never density or percentage. The explorer and table name each interval with its exact closure and report counts. Binning is recomputed when source/view rows change; no linked select for aggregated intervals.

Example values 0,1,2,3,4 with bins=2 produce bounds [0,2,4] and counts [2,3]. Values all equal 10 with bins=2 use [9.5,10,10.5], giving counts [0,N]. An empty view gives `[]`, not two invented empty bins.

## Pie/donut totals and visibility

Sum values in incoming row order. Angles and percentages use the sum of **legend-visible** categories. A zero category has no visible wedge but stays in the figure table and keyboard explorer while enabled. With a positive visible total, its share is 0%. If all visible values are zero, show `All visible values are zero.` and no fabricated sectors; the donut total is 0 and percentage text is `Not applicable`. Hiding all categories shows `All categories are hidden.` No division by zero is allowed.

The document's `sum(table,"column")` never changes when a legend is toggled. The center/figure caption must label the pie total `Visible total` so it is not confused with the source total. A visible row with a negative value is `E_CHART_VALUE`, even if a reader would later hide it.

## Linked selection

`select` writes the chosen **x scalar** into an already declared control. For text x, the destination is a choice and every currently prepared x belongs to its static options. For numeric x, destination is a slider and every prepared x belongs exactly to its authored grid. Constants, calculations, toggles, table names and unknown names are rejected. Schema-level type mismatch is a compile error; data-domain mismatch is `E_SELECTION_DOMAIN` during preparation.

Click/tap a datum or explicitly use the inspected value to create one normal state transaction. Every linked figure highlights all prepared data with that x after commit, across series and duplicate scatter points. Selecting the current value is a no-op with no new revision. Hover does not write state. Changing the corresponding native control updates the highlighted x. A chart may depend on the value it changes; this is an event, not an illegal graph cycle.

Filtering out the selected x does **not** reset the control, pick another row or write null. No mark is highlighted; add `The selected value is not in this figure's current data.` when applicable. The explicit control stays available unless the author conditionally hid it. Selection is single-valued only; no arrays/ranges. Clearing local inspection never clears linked state because no null selection exists in V1.

## Presentation-only interaction

Legend entries are native toggle buttons with `aria-pressed`; named series get a legend when there is more than one series, pie/donut get one entry per category. Their order is stable. Legend toggles affect geometry and inspection, not program state, data views, aggregates or saved source. All-hidden is allowed with a clear message and working restore buttons. If a series/category temporarily disappears because of filtering, preserve its hidden preference for that program instance; return it to the same preference if it reappears. Reset reading makes all entries visible.

Without select, click/tap pins local inspection. With select, click commits selection and pins the inspected datum on success. Hover updates inspection only when no inspection is pinned and focus is not in the chart explorer controls. Pointer leaving clears unpinned inspection. Escape while focus is in the explorer clears the local pin but not linked state. If the inspected mark disappears, move inspection to the nearest remaining index (last index when the old index is too large); if none remain, clear it. Pinned presentation never changes a data total.

## Keyboard and accessible alternative

Each figure is a `<figure>` with `<figcaption>`, a descriptive paragraph and a permanent **Show data** details element. SVG is visual-only (`aria-hidden="true"`); equivalent values/actions are supplied by real HTML controls and a semantic table. Do not require a screen reader to traverse thousands of SVG circles.

Provide a native integer range control labelled `Inspect data point`, with indices 1..N over visible prepared data (row-major, then series order), or bins for a histogram. Its `aria-valuetext` is `<x label>: <x>; <series label>: <value>; <index> of <N>`; interval text substitutes for histogram x. Native arrow/Home/End navigation must work. PageUp/PageDown moves ten positions. A visible **Use inspected value** button exists for linked selection; for unlinked figures use **Pin inspection**. These actions also respond to Enter/Space on their native buttons. Escape on the range unpins inspection. No role=application or page-global keyboard interception.

Pointer inspection and keyboard inspection address the same prepared data indices. Announce inspected values through a polite output on deliberate keyboard/button actions, debounced 150 ms; hover is not a live-region stream. Keep focus on the same range/button across state changes. When N becomes zero, disable the range/action without moving focus elsewhere unexpectedly and announce the empty state once. The data table includes all prepared rows/series, including legend-hidden ones, clearly labelled as such. Selection may additionally be applied by a `Use <x>` button in a table row for a linked figure. Do not rely on colour alone; use line dash/point-shape differences and text/selected outlines.

## Empty and error states

No rows: `No data matches the current choices.` No series visible: `All series are hidden.` Pie all categories hidden: the category-specific message. All-zero pie: the zero-total message. Errors are diagnostics, not fake zero charts. If an interaction causes a chart error, reject the entire candidate document revision. Initial failure prevents the reader from claiming a valid render. No last-known chart is silently combined with newly updated prose.

## One-point explorer boundary

The inspector is reader UI, not a declared Tinta slider. With one prepared point, display that point and disable range navigation; its Use value/Pin action remains available when applicable. With zero points, keep navigation/action disabled and show the specified empty explanation, preserving focus on an existing disabled control rather than unexpectedly removing it. Never create an invalid authored min=max control to implement this UI.
