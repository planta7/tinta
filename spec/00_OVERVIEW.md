# Language overview and normative authority

Contract revision: **1.0-draft.3**. Target source-format version: **1.0**. The language remains a draft; the source-format target is independent of software release versions.

**MUST**, **MUST NOT**, **SHOULD** and **MAY** are requirement levels in this package. MUST/MUST NOT are conformance requirements. SHOULD requires a written reason for deviation. MAY is optional only where explicitly stated; it must not introduce observable alternative semantics. No unspecified extension may be enabled in a conforming V1 reader.

## Document model

tinta is a language for interactive documents with Markdown-compatible text formatting. A document has prose, immutable author constants, reader-controlled scalar values, derived values, immutable typed tables, reactive views and figures. All declared names are global to that document. The language does not define screens, routes, web components, network actions or author styling.

There are twelve named directives: `meta`, `let`, `calc`, `slider`, `toggle`, `choice`, `when`, `details`, `data`, `view`, `table`, `chart`. `@end` is a block delimiter, not a thirteenth functional directive. The function registry contains eleven functions: `if`, `min`, `max`, `round`, `pow`, `count`, `sum`, `mean`, `fixed`, `percent`, `money`.

## Source modes

A `.md` file is opened in `markdown` profile: CommonMark plus the three documented extensions, with tinta recognition entirely disabled. A `.tinta` file is opened in `tinta` profile, unless the caller explicitly selects another profile. Profile is an API parameter; the pure engine never guesses a filename from global state. Unknown file extensions require an explicit profile or a UI choice.

An author may omit `@meta`; the default version is `1.0`, locale `en-US`, currency `USD`. New files require no configuration block. If present, metadata is a single root directive before any non-comment, nonblank content, with these supported keys only:

```tinta
@meta (version: "1.0", title: "An explorable note", locale: "en-US", currency: "EUR")
```

Version strings other than `1.0` produce `E_VERSION`; no nearest-version fallback. Compiled envelopes also identify the exact engine ABI and implementation build. Their compatibility must not be inferred from the source version alone.

## Representative complete source

```tinta
# A reading experiment

@let starting_readers = 100
@slider growth = 5 (min: 0, max: 20, label: "Growth per period (%)")
@slider period = 0 (min: 0, max: 4, label: "Period to inspect")

@data steps
period:number
0
1
2
3
4
@end

@chart line steps (
  x: "period",
  y: round(starting_readers * pow(1 + growth / 100, row.period)),
  select: period,
  title: "A hypothesis, not a forecast",
  yLabel: "Readers"
)

At period **{{ period }}**, the hypothesis gives
**{{ round(starting_readers * pow(1 + growth / 100, period)) }} readers**.

@when growth == 0
With no growth, the line is flat.
@end
```

The chart and text share the same controlled inputs. Selecting an x value changes an existing control; it does not run a general event handler.

## Compatibility promise

The Markdown syntactic base is CommonMark 0.31.2. Rendering is a **safe profile**, not raw HTML passthrough. GFM tables, task lists and double-tilde strikethrough are enabled; autolink literals, footnotes, math, MDX, YAML front matter and other extensions are not. Angle-bracket CommonMark autolinks remain supported. Existing Markdown containing those unsupported dialects is kept as source but is not promised the same presentation as its original application.

Enrichment preserves original source except for explicit collision escapes and optional user edits. It never overwrites the original file or automatically rewrites all Markdown through an AST printer. `.tinta` is not guaranteed to render interactively in ordinary Markdown readers: directives appear as text there.

## Evaluation promise

A compile validates syntax, names, types, graph cycles, static properties and defaults. Initial evaluation validates all derived values and currently visible content. A reader update creates one candidate revision; it either commits all resulting values and visible figures or commits nothing. Hidden conditions affect rendering, never confidentiality. Conditions are not access control.

## Omitted behaviour

No implicit casts; no truthiness; no null values; no arbitrary objects; no methods; no callbacks; no author-defined functions; no loops; no user code execution; no data mutation; no external evaluation; no implicit storage. If the language does not expressly define a behaviour, an implementation must reject its syntax rather than delegate to JavaScript or a chart library.
