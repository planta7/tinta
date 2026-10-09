# Product contract

## Purpose

A reader should be able to change an assumption, inspect a figure or choose a relevant explanation **without leaving the flow of a document**. The author should start with prose and add behaviour only where it helps understanding. A document remains a file owned by its author and readable as plain text.

The first delivery is a language/toolchain, not a validated commercial proposition. Do not add conversion funnels, templates for web landing pages or premium account logic.

## Required author journeys

**Existing document:** open a `.md` file → read unchanged Markdown in safe Markdown mode → choose **Enrich as Tinta** → review collision escapes and safe-renderer warnings → edit the new `.tinta` buffer → add one control and a related sentence/chart → save under a new filename. The original `.md` is not rewritten. A Markdown source containing `@when`, `{{ ... }}`, HTML or a fenced code sample must not silently acquire executable semantics.

**New document:** choose **New document** → receive a prose-first source with one heading and no application scaffold → write normal Markdown → insert directives directly or from documented completion snippets → read the result in Reading mode → save `.tinta`. No wizard, schema setup, project manifest or cloud account is required.

**Explorable article:** adjust a slider → values and figure update in one commit → inspect/select a point → its explanation updates → reset reading to the document's configured baseline. The action never modifies authored source.

**Local resource:** select a CSV, JSON or raster image → inspect inferred structure / local resource metadata → approve import → source and asset collection change as one undoable edit. A data import copies values into `@data`; it does not create an ongoing connection.

**Portable delivery:** choose source bundle or HTML export → choose initial/current state when relevant → see the privacy statement → download the artifact. Export does not imply upload, publication or sharing. Opening an exported HTML file by `file://` works offline.

## Required deliverables

A normative language specification; a conformance corpus; a parser/validator/evaluator SDK; a safe renderer; all seven chart types; a CLI; a local reference editor with static application and portable standalone builds; editable `.tinta`/`.tinta.zip`; interactive/static HTML; documentation; license notices; repeatable CI and manual qualification evidence.

The reference editor is intentionally small. It is not the future proprietary product. Its source belongs to the open reference toolchain. A future premium application may consume the public SDK from another repository without changing the file format or requiring its account for reading.

## Quality gates

Reading must work with keyboard only and at narrow widths. A valid input state cannot be partially applied. An invalid edit cannot be exported as though valid. A document cannot execute arbitrary code or fetch external content. All accepted files have explicit size/resource limits. File operations never overwrite without authorization. Export files must work without the editor, React, CodeMirror, network connectivity or build-time tooling.

## Content expectations

V1 supports Markdown prose, headings, nested lists, quotes, code, links, local images, tables, task lists and strikethrough. Static Markdown checkboxes are disabled presentational marks, not Tinta state controls. Paragraph order is author-defined; no layout engine or drag-and-drop page builder exists. Charts are figures in that order, with captions, controls for exploration and accessible data tables.

## Supported usage environments

The authoring editor targets modern desktop Chromium, Firefox and Safari; the reader and exports also require narrow/mobile reading qualification. The required automated browser engines are pinned Playwright Chromium, Firefox and WebKit. Real Safari on macOS and one real iOS Safari reading run are release gates, not capabilities established by emulation. CLI targets macOS arm64/x64, Linux x64 and Windows x64 on the pinned Node 24 line. Unsupported environments must fail or degrade explicitly; no compatibility claim is inferred from a single Chromium run.
