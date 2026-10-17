# Product contract

## Purpose

tinta is a language for interactive documents, combining prose, data, expressions and reader interaction. It uses Markdown-compatible text formatting. A reader should be able to change an assumption, inspect a figure or choose a relevant explanation **without leaving the flow of a document**. The author should start with prose and add behavior only where it helps understanding. A document remains a file owned by its author and readable as plain text.

The tools create and read local interactive documents.

## Authoring workflows

**Existing document:** open a `.md` file → read unchanged Markdown in safe Markdown mode → choose **Enrich as tinta** → review collision escapes and safe-renderer warnings → edit the new `.tinta` buffer → add one control and a related sentence/chart → save under a new filename. The original `.md` is not rewritten. A Markdown source containing `@when`, `{{ ... }}`, HTML or a fenced code sample must not silently acquire executable semantics.

**New document:** choose **New document** → start with a heading → write prose with Markdown-compatible formatting → insert tinta directives directly or from documented completion snippets → read the result in Reading mode → save `.tinta`. No wizard, schema setup, project manifest or cloud account is required.

**Explorable article:** adjust a slider → values and figure update together → inspect/select a point → its explanation updates → reset reading to the document's configured baseline. The action never modifies authored source.

**Local resource:** select a CSV, JSON or raster image → inspect inferred structure / local resource metadata → approve import → source and asset collection change as one undoable edit. A data import copies values into `@data`; it does not create an ongoing connection.

**Portable delivery:** choose source bundle or HTML export → choose initial/current state when relevant → see the privacy statement → download the artifact. Export does not imply upload, publication or sharing. Opening an exported HTML file by `file://` works offline.

## Language and tools

The repository includes the language specification, conformance tests, reusable parsing and evaluation packages, a document reader with seven chart types, a CLI and Studio. Studio is available as a static web application and a standalone HTML file. Documents can be saved as `.tinta` source, `.tinta.zip` bundles, interactive HTML or static HTML. Builds are reproducible and include dependency license notices.

The reference editor and reusable packages are open source under the MIT license. Applications can use the public SDK to read the same document format.

## Document guarantees

Reading must work with keyboard only and at narrow widths. A valid input state cannot be partially applied. An invalid edit cannot be exported as though valid. A document cannot execute arbitrary code or fetch external content. All accepted files have explicit size/resource limits. File operations never overwrite without authorization. Export files must work without the editor, React, CodeMirror, network connectivity or build-time tooling.

## Content expectations

V1 supports Markdown prose, headings, nested lists, quotes, code, links, local images, tables, task lists and strikethrough. Static Markdown checkboxes are disabled presentational marks, not tinta state controls. Paragraph order is author-defined; no layout engine or drag-and-drop page builder exists. Charts are figures in that order, with captions, controls for exploration and accessible data tables.

## Unsupported features

V1 does not provide layout primitives such as cards, columns, grids, pages or
routes, or freely positioned controls. It does not accept author components,
functions, loops, assignment statements, API requests, submitted forms,
JavaScript, CSS or executable code fences. Runtime plug-ins, packages, macros,
includes and module resolution are unsupported.

The tools do not provide collaboration, online sharing, telemetry, native
installers, automatic updates, synchronization, accounts, a database service,
monetization or AI features. Document processing stays local, without a document
publication workflow or hosting service. Software distribution is described
separately in [distribution](15_DISTRIBUTION.md).

PDF and flattened Markdown exports, real-time remote data, maps, 3D charts,
chart animation, pan/zoom/brush and multiple selection are unsupported. The
[chart specification](../spec/05_CHARTS.md) defines the seven supported chart types
and their interactions.

## Supported usage environments

The authoring editor targets modern desktop Chromium, Firefox and Safari; the reader and exports also provide narrow/mobile reading. CLI supports macOS arm64, Linux arm64 and Windows x64 on the pinned Node 24 line. Browser storage, file permissions and assistive-technology behavior depend on the actual environment. Automated Chromium, Firefox and WebKit tests exercise their pinned browser builds; WebKit results do not establish Safari or iOS compatibility. Unsupported features must fail or degrade explicitly rather than lose source or produce a misleading result.