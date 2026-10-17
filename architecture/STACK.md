# Stack selection and deterministic dependency locking

## Selected design

| Layer               | Selection                                                                | Boundary                                                                          |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Shared code         | TypeScript with strict checking, ESM                                     | Browser/Node semantic parity; no author JS.                                       |
| Runtime/toolchain   | Node 24 LTS; baseline 24.21.0                                            | Node powers local hosts/build/tests; exported HTML requires no Node installation. |
| Workspace           | pnpm workspace, exact dependency versions                                | No Nx/Turborepo required for this size.                                           |
| Markdown            | micromark + mdast-util-from-markdown                                     | Real block/inline parser extensions, original source spans.                       |
| Markdown extensions | Individual table, task-list, strikethrough micromark/mdast modules       | Do not enable all GFM/MDX/HTML extras by convenience.                             |
| Expressions         | Project-owned Pratt parser + typed bounded AST interpreter               | Closed function registry; no general scripting.                                   |
| Numeric behavior    | Finite binary64 + explicit formatting contract                           | Not an accounting decimal engine.                                                 |
| Charts              | `d3-array`, `d3-scale`, `d3-shape`; project-owned safe SVG scene adapter | No d3 global bundle, d3 DOM selections, remote chart loader or author Vega spec.  |
| Reader              | Typed DOM construction and SVG, framework-independent                    | Same semantic render plan used in interactive/static export.                      |
| Editor              | React 19 + CodeMirror 6                                                  | React never enters core/reader/export dependencies.                               |
| Bundling            | Vite 8 for editor; esbuild for IIFE reader/worker packaging              | Classic inline scripts in standalone artifacts avoid module/file-origin loading.  |
| ZIP                 | fflate                                                                   | Strict path, size, CRC and inflation checks remain project responsibilities.      |
| Hashing             | `@noble/hashes` SHA-256                                                  | Pure browser/Node digest without ambient filesystem/network.                      |
| Tests               | Vitest, fast-check, Playwright, axe-core                                 | Semantic fixtures, property tests, real browser interaction and a11y checks.      |
| Validation          | Ajv with JSON Schema 2020-12                                             | No coercion, default insertion or silent removal of unknown properties.           |

TypeScript avoids a second implementation and a Rust/WASM build/serialization bridge for a browser-centric document reader. Reconsider the implementation language only if measured parser or runtime limits require it. React is justified for file/dialog/editor state, not for the document engine. D3 supplies maintained geometry primitives; the project still owns chart semantics, accessible navigation and deterministic presentation. A generic chart grammar would expose far more capability than the product authoring model needs.

## Approved release lines

These release lines constrain dependency updates. Exact installed versions, integrity hashes and transitive dependencies are recorded in the package manifests and `pnpm-lock.yaml`. See [toolchain setup](../docs/09_FOUNDATION_TOOLCHAIN.md) for the current pinned environment.

| Dependencies                                      | Approved line                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Node                                              | 24.21.0 baseline; 24.x security patch upgrades through recorded maintenance                 |
| pnpm                                              | 10.x                                                                                        |
| typescript                                        | 6.x                                                                                         |
| react, react-dom, matching @types                 | React 19.x, @types 19.x                                                                     |
| vite, @vitejs/plugin-react                        | Vite 8.x; newest stable plugin release whose peer range accepts the locked Vite/React setup |
| micromark                                         | 4.x                                                                                         |
| mdast-util-from-markdown                          | 2.x                                                                                         |
| individual micromark/mdast GFM extension packages | Newest stable non-deprecated versions with compatible micromark/mdast peer requirements     |
| CodeMirror scoped packages                        | 6.x; state/view/language/commands/search/autocomplete/lint/lang-markdown                    |
| d3-array, d3-scale, d3-shape                      | 3.x, 4.x, 3.x respectively; matching @types                                                 |
| fflate                                            | 0.8.x                                                                                       |
| @noble/hashes                                     | 2.x                                                                                         |
| ajv, ajv-formats                                  | 8.x, 3.x                                                                                    |
| vitest, @vitest/coverage-v8                       | 5.x, same exact version                                                                     |
| @playwright/test                                  | 1.x; exact version and bundled browser revisions                                            |
| @axe-core/playwright                              | 4.x                                                                                         |
| fast-check                                        | 4.x                                                                                         |
| esbuild                                           | 0.x latest stable satisfying Node 24                                                        |
| @types/node                                       | 24.x                                                                                        |

## Dependency updates

Dependency updates use stable, non-deprecated releases within the approved lines, with compatible engines and peer requirements. Resolve runtime, workspace manager, TypeScript, React, Vite/plugin, parser, editor, charts, IO and test dependencies in that order. An unavailable approved line is a compatibility issue; changing the selected architecture requires a technical decision.

Pin exact versions in manifests and `packageManager`, the exact Node version in `.node-version`, `.nvmrc` and CI, and CI actions to full reviewed commit SHAs. Keep `save-exact=true`, `engine-strict=true` and strict peer checks. Installation uses `pnpm install --frozen-lockfile`; floating versions, wildcard ranges, Git branch dependencies and unpinned actions are not supported. Workspace source packages remain private. Only generated manifests for the ten explicitly allowlisted npm targets may become publishable under the [software distribution contract](../docs/15_DISTRIBUTION.md); root and application manifests remain private. This exception never bypasses source architecture checks.

A dependency update includes its lockfile, official provenance, integrity records and license notices. Check engine/peer compatibility, Node/browser imports, types, dependency boundaries and applicable vulnerability advisories. Security fixes may move a patch/minor within the approved line; a major-line change needs a compatibility decision. Do not switch stacks to mask a failed compatibility check.


## Compiler configuration

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch` and `forceConsistentCasingInFileNames` are true. Core targets ES2022 with no DOM library. Browser packages use ES2022 + DOM; Node packages use Node types. Use explicit `.js` import suffixes in emitted ESM paths and TypeScript project references. No implicit `any`, `@ts-ignore`, untyped evaluator escape hatch or CommonJS fallback in core.

Test code may use Node built-ins; portable packages may not import `node:*`. Architecture tests enforce this and prohibit React/CodeMirror in reader/export bundles. Dependency license compatibility and notices are checked before release; a dependency is not safe simply because its name appears in this table.

## Sources

See `docs/SOURCES.md`: S01–S12, S15–S18. External documentation supports the tools' capabilities; the architecture above defines how tinta uses them.

## Local VS Code host

The native host target is VS Code Desktop 1.141.0, pinned probe commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c` (Electron 43.7.7, Node 24.21.0). Repository builds still use Node 24.21.0. The host uses bundled ESM analysis in Node workers and the existing framework-free browser preview in an opaque frame. It requires no global CLI or separate Node installation for document editing. See [host behavior and limits](../docs/13_VSCODE.md) for platform limitations.

The compatibility probe uses the locked esbuild and the installed desktop's `vscode` API. The desktop binary is an external test prerequisite, not a redistributed dependency; retain its upstream license/notices in that installation. Record its version and commit with results. The local LSP adapter selects vscode-languageclient and vscode-languageserver 10.x (exact 10.1.2), with @types/vscode 1.140.x (exact 1.140.0). These stable typings cover the APIs used on the pinned 1.141.0 runtime; matching 1.141.0 typings are unavailable. Their transitive dependencies are pinned and inventoried. Native tests use the existing desktop runner; test-electron is not installed. Local and release VSIX packaging use the pinned official vsce tool described below; fflate remains responsible for inspecting archive contents. These SDK allowances apply only to their native client/server owners. Language-service coverage must preserve the existing syntax/engine minimums: 95% statements/lines and 90% branches. Host/transport coverage is separate, at least 85% statements/functions/lines and 80% branches.

Native file workflows add no external dependencies. The existing engine and artifact packages run in a fixed bundled Node artifact worker, separate from the LSP and browser entries; the extension host supervises its 3000 ms watchdog and shared local-file grants.

## Software publication tools

Version recommendations and release notes use release-it 21.1.1 with @release-it/conventional-changelog 12.0.2 and the conventional-changelog-conventionalcommits 10.4.1 preset. Read-only tool modes consume a generated private planning manifest; source manifests remain private and unchanged. The small version mapping preserves coordinated npm and extension versions. The exact lock, registry provenance and original notices include these development tools.

GitHub Actions expresses release ordering, concurrency, platform matrices and failure handling. Official npm 11.21.0 publishes the tested tarballs with trusted publishing; npm 11.19.0 remains the installed-consumer baseline. Official @vscode/vsce 2.26.1 packages the explicit extension payload and publishes the prebuilt VSIX with Azure CLI federation through the pinned Azure/login action. GitHub CLI creates the immutable source tag and draft release; official artifact and Pages actions transfer the tested files and deploy the completed Studio download. Publication tools are not embedded in product runtimes.

The vsce tool's Markdown dependency is scoped to markdown-it 14.3.1, including linkify-it 5.0.2, for its security fixes. The release tool's get-uri dependency uses basic-ftp 6.2.1 for the directory-listing denial-of-service fix; its consumed API remains compatible. These overrides affect development tools only. Product dependencies and the parser architecture are unchanged.
