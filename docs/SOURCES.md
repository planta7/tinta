# Primary technical references

These references support tool selection and platform constraints. Resolve and verify exact dependency versions during M0.

## S01 — CommonMark 0.31.2 specification and fixtures

https://spec.commonmark.org/0.31.2/

The exact base Markdown parsing target; vendor the official examples under their own license.

## S02 — micromark repository

https://github.com/micromark/micromark

Tokenizer extension architecture, CommonMark support and safe/default HTML handling; use original spans.

## S03 — TypeScript handbook

https://www.typescriptlang.org/docs/handbook/intro.html

Typed JavaScript tooling; the choice of a shared interpreted engine is a project design decision.

## S04 — Node.js previous releases

https://nodejs.org/en/about/previous-releases

Node release information for verifying the selected baseline during M0.

## S05 — D3 documentation

https://d3js.org/

Modular data/scale/shape helpers. Tinta, not D3, defines selection and chart semantics.

## S06 — Vite getting started

https://vite.dev/guide/

Browser tooling and runtime requirements; official current major line reviewed for stack selection.

## S07 — Vitest getting started

https://vitest.dev/guide/

Test runner compatibility and current release-line guidance.

## S08 — Playwright browser support

https://playwright.dev/docs/browsers

Pinned bundled browser builds; emulated WebKit is not a claim of real Safari/manual coverage.

## S09 — CodeMirror development repository migration notice

https://github.com/codemirror/dev

The GitHub development repository is archived following a hosting migration, not evidence that CodeMirror itself was abandoned.

## S10 — CodeMirror current development repository

https://code.haverbeke.berlin/codemirror/dev

Repository linked by the official migration notice; resolve actual package patches and notices in M0.

## S11 — remark-gfm repository

https://github.com/remarkjs/remark-gfm

Reference for GFM behaviours; Tinta selects table/task-list/strikethrough modules rather than enabling the entire aggregate.

## S12 — fflate repository

https://github.com/101arrowz/fflate

ZIP/deflate primitives. Tinta still owns ZIP integrity, limits and path validation.

## S13 — MIT license text (Open Source Initiative)

https://opensource.org/license/mit

Permissive license text; third-party material retains its own terms.

## S14 — Web Content Accessibility Guidelines 2.2

https://www.w3.org/TR/WCAG22/

Accessibility target, not a certification or an assertion that the prototype is compliant.

## S15 — MDN Content Security Policy guide

https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP

Hash-based scripts, restrictions and CSP trust boundaries.

## S16 — MDN iframe element

https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

Sandbox capabilities and iframe restrictions.

## S17 — MDN File System API

https://developer.mozilla.org/en-US/docs/Web/API/File_System_API

File capabilities and availability boundaries; baseline local file inputs/downloads do not depend on this API.

## S18 — MDN showSaveFilePicker

https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker

Feature detection and limited availability; no promise that it works in every browser/file origin.

## Internal decisions versus external facts

The `.tinta` extension, syntax, functions, chart semantics, limits, exports, component boundaries and delivery gates are this project’s design, not assertions about any third-party product. No exclusive file-extension registration, trademark clearance or package-name availability has been established. No external competitor review is required before implementing the agreed local scope. External websites may change after this dated review; the repository lock and recorded qualification evidence become the source of truth for actual installed versions.
