# Implementation roadmap

Milestones M0–M7 build on their listed prerequisites. Acceptance requires actual automated and manual results. Unavailable suites fail explicitly; source expectations remain NOT_RUN and execution reports remain separate. Verification selects explicit supported targets and implemented suites, independent of local progress files.

## M0 — Foundation and reproducible toolchain

**Prerequisite:** None; documentation package only.

**Owning scope:** Workspace, package boundaries, documentation tooling and build infrastructure.

**Read:** `DECISIONS.md`, `architecture/STACK.md`, `architecture/MODULES.md`, `contracts/public-api.d.ts`, `contracts/worker-protocol.d.ts`, `docs/07_VERIFICATION.md`

### Required implementation

1. Inspect the new directory and preserve existing files. Initialize local Git only when it is not already a repository; never create/push a remote. Create the eight workspace packages/directories specified in architecture/MODULES.md, with private manifests and no implemented product behaviour.

2. Execute the exact dependency resolution procedure. Pin the selected Node/pnpm versions, manifests, engines, transitive lock, browser builds and reviewed CI action SHAs. Capture official registry fields, resolution UTC time, integrity/license inventories, audit outcomes and actual install/import compatibility. Registry failure is BLOCKED, not an excuse to fabricate versions.

3. Configure strict TypeScript project references, ESLint flat config, Prettier, pnpm workspace, Vite/editor and esbuild reader/worker entry scaffolds, Vitest, Playwright, coverage and import-boundary checks. Empty future packages may have an empty exported module, never success-returning fake engine functions.

4. Make root scripts format:check, lint, typecheck, test:unit, test:conformance, test:browser, build, check:architecture, check:licenses and verify available. Stage-aware aggregate gates only run implemented stages; an explicitly requested unimplemented semantic/browser stage exits nonzero with NOT_IMPLEMENTED, never PASS. Do not use passWithNoTests.

5. Add real smoke tests for typed contract compilation, workspace dependency boundaries, Node/browser import compatibility, registry/schema structure and build-to-one-file packaging primitives. JSON Schema files are checked with Ajv 2020 in this project, not accepted on appearance alone.

6. Configure CI on pull requests/push to the repository default branch when a hosted remote is eventually added. No workflow deployment/publishing/credentials. The local equivalent pnpm verify must also work without a remote.

7. Record exact commands, environment versions, exit codes and assertion counts. Keep semantic cases/scenarios unchanged at NOT_RUN; execution results are separate.

### Acceptance gate

- Documentation package validation passes; public declarations compile with the resolved TypeScript.
- Frozen reinstall succeeds; production/browser/Node helper imports and peer dependencies agree.
- Root infrastructure scripts run real scoped tests; absent product functions cannot generate passing semantic results.
- Dependency/architecture/license checks have evidence and no undisclosed high/critical applicable blocker.
- SC-042 passes with actual exact version and integrity records.

**Scope boundary:** Do not implement the parser, engine, chart renderer, editor features or any publication workflow.



## M1 — Lossless Markdown and Tinta syntax

**Prerequisite:** M0

**Owning scope:** @tinta/types and @tinta/syntax.

**Read:** `spec/00_OVERVIEW.md`, `spec/01_MARKDOWN_AND_LEXING.md`, `spec/grammar.ebnf`, `spec/03_DIRECTIVES.md`, `spec/04_DATA.md`, `contracts/public-api.d.ts`, `conformance/README.md`

### Required implementation

1. Implement strict UTF-8/source indexing, original UTF-16 offsets, BOM/CRLF mapping and resource budgets. Keep lossless source and stable node IDs; diagnostics point at original spans.

2. Implement CommonMark0.31.2 parsing with only selected GFM extensions using micromark/mdast extensions. Vendor the exact official CommonMark conformance examples and license, record their hash and run the full corpus in Markdown profile.

3. Implement all twelve Tinta directive forms, @end blocks, option groups/multiline rules, typed data lexical rules and the bounded Pratt expression AST. Complete context-aware double-brace interpolation and escaping. Do not implement Markdown with global regex replacement.

4. Implement enrichMarkdown as a token-aware edit set preserving safe rendering in Markdown mode, leaving original buffers/files untouched. Include raw HTML/comments, fences, nested containers, link destinations/labels and literal templates.

5. Add parse-stage conformance adapter assertions now; semantic expectations remain unrun until M2 rather than being weakened. Bind future semantic fixtures to parsed expression/directive structures where useful without claiming evaluation.

6. Generate grammar-aware editor-token metadata only from the parser/registry contract, not a parallel semantic parser. Capture parser suite results and CommonMark corpus provenance.

### Acceptance gate

- Complete pinned CommonMark parser corpus passes; safe-render exceptions are not used to skip parse tests.
- SC-045 and SC-046 pass; lexical/enrichment expectations and span regressions are covered.
- Every grammar production has positive, malformed and boundary cases; resource ceilings are enforced.
- No source normalization/reprinting changes unedited Markdown beyond specified enrichment edits.

**Scope boundary:** Do not invent semantic defaults, execute source code, implement UI features or claim the full document examples run yet.



## M2 — Typed engine and transactional state

**Prerequisite:** M1

**Owning scope:** @tinta/engine with closed public IR and semantic adapter.

**Read:** `spec/02_EXPRESSIONS_AND_STATE.md`, `spec/03_DIRECTIVES.md`, `spec/04_DATA.md`, `spec/05_CHARTS.md`, `spec/06_LIMITS_AND_DIAGNOSTICS.md`, `contracts/CONTRACT_RULES.md`, `contracts/public-api.d.ts`, `conformance/cases.json`

### Required implementation

1. Implement binding, types, constant/derived/view dependency graph, forward references, cycles, static properties, control grids, all eleven functions and deterministic diagnostics. Implement prepare/evaluate semantics for all seven chart types as pure data, without DOM/SVG yet.

2. Implement createSession, complete-baseline validation, setControl/setControls, exact no-op rules, rollback, reset, subscriptions, disposal and explicit rejection of synchronous reentrant mutations. No partial revision is observable.

3. Implement typed data/views and sum/mean/count, row/global scoping, stable sort, empty schemas, hidden conditional lazy evaluation and eager calculations/views/collapsed details.

4. Implement encodeProgram/decodeProgram. Generate a full closed JSON schema for ProgramIR, validate unknown keys/types/graphs/spans/source hash/control grids, and test untrusted round trips. The envelope schema alone is not sufficient.

5. Implement CSV/JSON pure importers and complete their conformance phase adapter, without host filesystem/UI. Implement public compile/evaluate/prepare bindings so semantic cases can run through only the public contract.

6. Run all semantic cases except browser-only effect assertions and later source-artifact integration gates; those exceptions remain explicitly NOT_RUN. Extend cases to cover every error and numeric boundary introduced. Record actual expected-versus-observed values.

### Acceptance gate

- Applicable CT-001..CT-098 semantic assertions pass; browser-effect assertions within cases are tracked separately for M3/M5, not marked complete prematurely.
- Every function/type/operator/domain and full transaction failure path has tests; decimal control grid never uses epsilon matching.
- IR decode rejects malicious/unknown forms and respects all operation/size limits.
- Charts prepare correct type/ordering/selection/histogram semantics without relying on renderer state.
- Coverage meets the syntax/engine thresholds; no runtime eval/Function/ambient IO in portable packages.

**Scope boundary:** Do not turn chart options into an external chart grammar, add user functions, or build the editor ahead of its reader/export foundations.



## M3 — Safe document reader

**Prerequisite:** M2

**Owning scope:** @tinta/reader document rendering, controls, focus and lifecycle.

**Read:** `docs/03_EDITOR_AND_READER.md`, `docs/04_SECURITY.md`, `docs/05_ACCESSIBILITY_AND_DESIGN.md`, `spec/01_MARKDOWN_AND_LEXING.md`, `contracts/public-api.d.ts`

### Required implementation

1. Render typed Markdown flow with safe DOM construction, inert author HTML, comments policy, links/local-image placeholders, tables and all native controls. Keep source/style/JS out of author execution paths.

2. Implement condition visibility/details, document revisions and focus preservation, error rollback presentation, reading reset, diagnostics and lifecycle cleanup. Tables contain correct headers/captions/counts; task-list checkboxes remain disabled static content.

3. Create the standalone reader entry and CSS build with no React/CodeMirror/compiler dependency. At this stage document-only fixtures may run; figures not yet rendered are explicitly identified as unimplemented in development, never silently omitted in a purported complete export.

4. Run the browser effect assertions from CT fixtures and SC-001/SC-035 in all three pinned browser engines. Test unusual DOM host inputs, multiple instances, subscriber failures and destroy behavior.

5. Add accessibility automation and screenshot baselines for synthetic document fixtures. The screenshot is evidence for later review, not proof of manual acceptance.

### Acceptance gate

- Safe rendered text/links/code/HTML behaviours and native control/condition transactions pass in Chromium, Firefox and WebKit.
- SC-001 and SC-035 pass with actual browser assertions.
- No reader dependency on editor frameworks or arbitrary HTML insertion; mounting/destruction has no retained listeners.
- Focus, labels, reduced-motion and non-colour document cues match the design contract.

**Scope boundary:** Do not declare seven-chart or artifact export support complete before M4/M5. No editor/file manager/cloud UI.



## M4 — Seven interactive chart types

**Prerequisite:** M3

**Owning scope:** @tinta/charts and chart portion of @tinta/reader.

**Read:** `spec/05_CHARTS.md`, `docs/05_ACCESSIBILITY_AND_DESIGN.md`, `docs/04_SECURITY.md`, `contracts/public-api.d.ts`, `examples/chart-atlas.tinta`, `conformance/scenarios.json`

### Required implementation

1. Implement safe SVG scene geometry for line/area/bar/scatter/pie/donut/histogram using only selected D3 geometry helpers. Match domains, order, shapes, grouped/unstacked conventions, dimensions, ticks, precision and numeric rejection rules.

2. Implement pointer inspection, keyboard range explorer/action, complete figure data tables, legend-only visibility, pins, linked control selection and cross-figure/text updates. Empty/all-hidden/all-zero/outside-filter/single-point states are explicit.

3. Keep all semantic computations in the engine; per-chart UI state cannot mutate tables or global aggregates. Reject a failing chart candidate atomically with the rest of its document revision.

4. Run the four principal complete example documents and all chart/selection tests in all three browser engines. Add all type-matrix negative cases, histogram property checks and lifecycle/ResizeObserver regressions.

5. Record SVG/DOM snapshots at specified sizes and real pointer/keyboard observations; preserve synthetic-only fixtures and distinguish automatic from manual visual acceptance.

### Acceptance gate

- SC-028..SC-034 pass and all seven chart types work in the article flow.
- The 98 seed semantic fixtures have their applicable engine/reader effect assertions completed or explicitly deferred only where tied to M5 artifact/import UI.
- Histogram counts conserve observations; zero/negative/duplicate/hidden selection and exact control mapping have tests.
- Keyboard exploration provides the same values/actions without requiring SVG traversal; zero/single-point inspectors behave correctly.
- Framework/DOM/geometry boundaries and size/resource rules remain intact.

**Scope boundary:** No zoom/pan/brush/animation, styling DSL, chart builder dashboard or new chart types.



## M5 — Local artifacts, imports and command line

**Prerequisite:** M4

**Owning scope:** @tinta/artifacts, @tinta/cli and local file capability adapters.

**Read:** `docs/02_FILES_AND_EXPORTS.md`, `docs/04_SECURITY.md`, `docs/06_CLI.md`, `schemas/bundle.schema.json`, `schemas/state.schema.json`, `schemas/interactive-envelope.schema.json`, `contracts/public-api.d.ts`

### Required implementation

1. Implement explicit local image capabilities, raster validation, source hashing, answer snapshots, canonical bounded ZIP reading/writing and atomic host writes. Validate duplicate JSON keys, CRC/inflation/path/hash rules before committing anything.

2. Implement standalone interactive and static HTML from the same evaluated render plan. Interactive includes complete source/IR with initial/current baseline, strict CSP and no-script fallback; static contains only resolved visible content/assets and no executable program.

3. Implement every documented CLI command/options/exit code and JSON record shape; invalid combinations are usage errors. Confirm both installed bin use and `pnpm --filter @tinta/cli exec tinta` workspace execution by linking the workspace bin at the root or equivalent tested package setup.

4. Implement bundle and HTML exports of all complete examples, CSV/JSON data-import fragment output and fixture ZIP round trips. Test all overwrite/alias/root-grant/error/cancellation paths on macOS/Linux/Windows.

5. Implement `tinta studio` locating/copying the artifact contract without a network server. Until the full M6 Studio artifact is built, its missing-artifact path is an explicit nonzero failure and the success gate remains deferred to M6.

6. Intercept network in the exported files and test actual file:// navigation in Chromium/Firefox/WebKit, including payload terminators, missing JS, all image formats and current versus initial answer semantics.

### Acceptance gate

- SC-002/004/005/006/007, SC-010..SC-018 and SC-038/039 pass.
- All applicable semantic/import cases pass through public APIs/CLI without schema coercion or silent type conversion.
- Interactive exports stay functional offline; static exports omit hidden source/data/assets; no runtime editor or CDN.
- Malformed/oversized images/bundles/snapshots fail before filesystem effects; output/source identity and atomicity tests pass.
- CLI `studio` invalid/missing handling passes now; success against the final production Studio remains the single explicitly deferred M6 CLI subgate.

**Scope boundary:** No publication commands, API fetching, backend, PDF generator, external storage or browser-launch side effects.



## M6 — Local reference editor

**Prerequisite:** M5

**Owning scope:** @tinta/studio, worker/preview adapters and final Studio artifact.

**Read:** `docs/03_EDITOR_AND_READER.md`, `docs/04_SECURITY.md`, `docs/05_ACCESSIBILITY_AND_DESIGN.md`, `contracts/worker-protocol.d.ts`, `contracts/CONTRACT_RULES.md`, `docs/02_FILES_AND_EXPORTS.md`

### Required implementation

1. Implement the specified welcome/read/edit workflow with CodeMirror, Markdown/Tinta profile distinction, explicit enrichment, diagnostics, snippets, unsaved checks, source/bundle/HTML/state dialogs and four examples.

2. Implement worker compilation with original source diagnostics, stale revision rejection, watchdog termination, capability MessageChannel preview initialization and opaque sandbox. Preview must not gain host storage/file access.

3. Implement state reconciliation, invalid-preview banner/disabled controls/exports, reset and source dirty semantics. File-save fallback messages must not claim an unobservable disk write succeeded.

4. Implement local CSV/JSON schema preview, image import/resolution and undo; opt-in IndexedDB recovery with limits/deletion/quota warnings, off by default. No account, automatic persistence of answers or network API.

5. Produce one `tinta-studio.html` that opens via file:// without external chunks, with trusted embedded worker/preview runtimes. Verify `tinta studio` resolves/copies it successfully; close M5’s single deferred success subgate.

6. Run all editor, local file fallback, actual source+asset undo, source changes during export, all browser-engine standalone cases and a complete owner-oriented example flow. Collect screenshots and test evidence.

### Acceptance gate

- SC-003, SC-020..SC-027 and SC-044 pass; complete Studio CLI success path passes.
- The standalone editor opens local files, enriches/saves/exports and works offline in the three browser engines without requiring File System Access.
- All four examples remain documents-first, reading is default, no layout-builder controls appear.
- Worker/sandbox messages fail closed; unsaved data is preserved through invalid source/timeouts/quota failures.
- Recovery is off by default and visibly distinct from saving; generated English UI and documentation agree.

**Scope boundary:** No AI assistant, publishing/sharing, native installer, sync, account, collaboration or commercial feature work.



## M7 — Conformance, hardening and release qualification

**Prerequisite:** M6

**Owning scope:** All implemented packages, release artifacts and evidence only.

**Read:** `docs/07_VERIFICATION.md`, `docs/04_SECURITY.md`, `docs/05_ACCESSIBILITY_AND_DESIGN.md`, `docs/08_CHANGE_CONTROL.md`, `conformance/requirements.json`, `docs/ROADMAP.md`

### Required implementation

1. Run the complete expanded semantic corpus, CommonMark suite, browser suite, CLI matrix, coverage, license/audit/import-boundary/size gates and final property/fuzz counts against one frozen candidate commit.

2. Generate and run locked S/M/L/dense performance corpus, record actual environment/timing/memory measurements, and compare each threshold without quietly raising it.

3. Execute real macOS Safari+VoiceOver, Windows Firefox+NVDA, real iOS Safari reader and visual keyboard/contrast/reflow acceptance with a named reviewer and exact versions. Missing environments stay BLOCKED; automation cannot impersonate a human review.

4. Complete requirements traceability so every normative behaviour/diagnostic/limit has test or explicit manual evidence. Resolve real defects, rerun directly impacted gates and preserve the original expected contract unless an authorized correction is recorded.

5. Build final `.tinta` examples/source bundle, reader runtime, standalone Studio, CLI distribution and source/type packages; include all license notices, exact source/engine revisions, hashes and known limitations.

6. Produce a release readiness report. A fully qualified local candidate may be marked PASS, but tagging/hosting/publishing remains a separate explicit owner action. Do not register names, push a repository or publish npm packages automatically.

### Acceptance gate

- All mandatory stage subgates are closed with no hidden NOT_RUN/BLOCKED/skipped result.
- SC-008/009/019/036/037/040/041/043 and all remaining cases/scenarios pass with appropriate automated or manual evidence.
- All seven charts, three artifact outputs and complete local editor/CLI agree on the same source meaning.
- Security, accessibility, performance and actual supported-environment claims are backed by records.
- Owner reviews the acceptance report; release permission is recorded separately from technical qualification.

**Scope boundary:** Do not expand V1 scope, refactor unrelated accepted code, spend on external services, or publish anything without authorization.

