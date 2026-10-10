# Decision register

Status: normative scope and implementation baseline, 8 October 2026.

## Product decisions

| ID | Binding decision |
|---|---|
| OWN-01 | First version is language and tools: specification, reusable engine, CLI, local web reader/editor, local files and exports. |
| OWN-02 | The draft syntax can evolve before stabilization; historical prototypes are not compatibility contracts. |
| OWN-03 | Users must be able to enrich existing Markdown documents. |
| OWN-04 | V1 interaction scope: existing controls, formulas, conditions, details, tables/views and seven interactive chart types, including linked selection. |
| OWN-05 | Everything is local. Do not design a publication workflow now. |
| OWN-06 | Editable source, autonomous interactive HTML and static HTML are accepted. PDF and flattened Markdown exports are outside V1. |
| OWN-07 | No AI in this version. |
| OWN-08 | Specification and engine are open; a future commercial product above them may remain closed. |
| OWN-09 | Tinta is an independent project with `.tinta` UTF-8 source and `.tinta.zip` source bundles. |
| OWN-10 | All documentation and project material in English. |

## Technical decisions

| ID | Decision | Rationale |
|---|---|---|
| DES-01 | Accept `.tinta` as plain text; `.tinta.zip` is a separate portable container. | Keep source readable and diffable, even when a document has images. |
| DES-02 | Working repository `tinta`, CLI `tinta`, internal packages `@tinta/*`. No public name registration. | Internal workspace identifiers do not claim ownership of a public namespace. |
| DES-03 | Language target `1.0`, contract revision `1.0-draft.3`; no stable release claim. | Separate the intended format from implementation maturity. |
| DES-04 | CommonMark 0.31.2 base with exactly GFM tables, task lists and double-tilde strikethrough. | Explicit, testable Markdown scope. |
| DES-05 | `{{ expression }}`, option groups `(key: value, ...)`, `@end` blocks and explicit `row.field`. | Reduce literal-text collisions, multiline friction and row-name ambiguity. |
| DES-06 | Markdown mode never activates Tinta; enrichment is explicit, reversible at the file level and collision-aware. | Never silently execute enrichment syntax in imported prose. |
| DES-07 | TypeScript engine, micromark/mdast, React + CodeMirror reference editor, D3 helpers + SVG reader, Node 24 CLI. | One portable semantic engine without a WASM bridge; framework-free exports. |
| DES-08 | MIT for this original specification, engine, reference tools, fixtures and examples. Future proprietary product lives separately. | Open infrastructure and an uncomplicated downstream boundary. |
| DES-09 | Raw author HTML is displayed inert, except HTML comments, which remain non-rendered notes. | Markdown compatibility does not authorize HTML execution. |
| DES-10 | No remote resource fetching. Local raster images only; imported CSV/JSON become embedded typed tables. | Local, reproducible documents with explicit resources. |
| DES-11 | No automatic persistence of reader answers. The reference editor automatically keeps local drafts and restores the open document on refresh; these are not saved source files. | Separate recovery from saving and interpretation state. |
| DES-12 | An interactive export includes source, all data and hidden branches. A static export includes only the resolved visible presentation and referenced visible images. | Make the confidentiality boundary explicit. |
| DES-13 | Formatting defaults `en-US` and `USD`, with explicit supported locale/currency overrides. | Make formatting defaults explicit. |
| DES-14 | An interactive state update is transactional; an invalid candidate rolls back entirely. | Text, charts, selections and totals must not disagree. |

## Explicit non-goals

No layout primitives such as cards, columns, grids, pages or routes. No freely positioned controls. No author components/functions, loops, assignment statements, API requests, forms with submission, JavaScript, CSS or executable code fences. No runtime plug-ins, packages, macros, includes or module resolution. No collaboration, online sharing, telemetry, native installer, auto-updater, sync, accounts, database, monetization or AI. No PDF renderer, Markdown down-converter, real-time remote data, maps, 3D charts, chart animation, pan/zoom/brush or multi-selection.

Extension uniqueness, trademark clearance and public package-name availability are **not** claimed. Do not globally take over `.tinta` file associations; open files through explicit user selection. A future installer must obtain consent for any association.
