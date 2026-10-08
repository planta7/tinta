# Stack selection and deterministic dependency locking

## Selected design

| Layer | Selection | Boundary |
|---|---|---|
| Shared code | TypeScript with strict checking, ESM | Browser/Node semantic parity; no author JS. |
| Runtime/toolchain | Node 24 LTS; baseline 24.21.0 | Node is for CLI/build/test only, not required to read exported HTML. |
| Workspace | pnpm workspace, exact dependency versions | No Nx/Turborepo required for this size. |
| Markdown | micromark + mdast-util-from-markdown | Real block/inline parser extensions, original source spans. |
| Markdown extensions | Individual table, task-list, strikethrough micromark/mdast modules | Do not enable all GFM/MDX/HTML extras by convenience. |
| Expressions | Project-owned Pratt parser + typed bounded AST interpreter | Closed function registry; no general scripting. |
| Numeric behaviour | Finite binary64 + explicit formatting contract | Not an accounting decimal engine. |
| Charts | `d3-array`, `d3-scale`, `d3-shape`; project-owned safe SVG scene adapter | No d3 global bundle, d3 DOM selections, remote chart loader or author Vega spec. |
| Reader | Typed DOM construction and SVG, framework-independent | Same semantic render plan used in interactive/static export. |
| Editor | React 19 + CodeMirror 6 | React never enters core/reader/export dependencies. |
| Bundling | Vite 8 for editor; esbuild for IIFE reader/worker packaging | Classic inline scripts in standalone artifacts avoid module/file-origin loading. |
| ZIP | fflate | Strict path, size, CRC and inflation checks remain project responsibilities. |
| Hashing | `@noble/hashes` SHA-256 | Pure browser/Node digest without ambient filesystem/network. |
| Tests | Vitest, fast-check, Playwright, axe-core | Semantic fixtures, property tests, real browser interaction and a11y checks. |
| Validation | Ajv with JSON Schema 2020-12 | No coercion, default insertion or silent removal of unknown properties. |

TypeScript avoids a second implementation and a Rust/WASM build/serialization bridge for a browser-centric document reader. Rust may be revisited only if measured parser/runtime limits cannot be met; enthusiasm or an unrelated repository convention is not sufficient. React is justified for file/dialog/editor state, not for the document engine. D3 supplies maintained geometry primitives; the project still owns chart semantics, accessible navigation and deterministic presentation. A generic chart grammar would expose far more capability than the product authoring model needs.

## Approved release lines

The following are major-line constraints, **not a fabricated lockfile**. M0 resolves and records exact patches. Exact installation and compatibility must be verified during M0.

| Dependencies | Approved line |
|---|---|
| Node | 24.21.0 baseline; 24.x security patch upgrades through recorded maintenance |
| pnpm | 10.x |
| typescript | 6.x |
| react, react-dom, matching @types | React 19.x, @types 19.x |
| vite, @vitejs/plugin-react | Vite 8.x; newest stable plugin release whose peer range accepts the locked Vite/React setup |
| micromark | 4.x |
| mdast-util-from-markdown | 2.x |
| individual micromark/mdast GFM extension packages | Newest stable non-deprecated versions with compatible micromark/mdast peer requirements |
| CodeMirror scoped packages | 6.x; state/view/language/commands/search/autocomplete/lint/lang-markdown |
| d3-array, d3-scale, d3-shape | 3.x, 4.x, 3.x respectively; matching @types |
| fflate | 0.8.x |
| @noble/hashes | 2.x |
| ajv, ajv-formats | 8.x, 3.x |
| vitest, @vitest/coverage-v8 | 5.x, same exact version |
| @playwright/test | 1.x; exact version and bundled browser revisions |
| @axe-core/playwright | 4.x |
| fast-check | 4.x |
| esbuild | 0.x latest stable satisfying Node 24 |
| @types/node | 24.x |

## M0 resolution algorithm — no discretionary substitutions

1. Query the official npm registry and Node release index from the development environment. Record UTC time and responses' selected fields in `reports/verification`.
2. For each approved line, collect releases matching the line; reject prereleases and versions marked deprecated. Pick the highest semantic version satisfying declared engines and already-selected peers. Process runtime, workspace manager, TypeScript, React, Vite/plugin, parser, editor, charts, IO and test packages in that order. For unconstrained helpers, choose the highest compatible stable version. Do not downgrade a selected major to mask a conflict.
3. Pin exact versions in every manifest and `packageManager`; pin exact Node in `.node-version`, `.nvmrc` and CI. Use `save-exact=true`, `engine-strict=true`, strict peer checks. Set the root package private; all package publication is disabled in V1.
4. Install, commit `pnpm-lock.yaml`, record integrity hashes and licenses, and run typecheck, Node/browser import smoke tests, dependency audit and the M0 gate. If resolution, installation or compatibility fails, M0 is BLOCKED with evidence; do not claim this document proved installation.
5. After M0, all commands use `pnpm install --frozen-lockfile`. No floating `latest` commands, wildcard versions, Git branch dependencies or unpinned CI actions. Pin GitHub actions to full commit SHAs resolved from their official repositories during M0.
6. A security fix may move a patch/minor within the approved line, with an impact report and relevant gates. A major change or unavailable approved line requires a documented deviation. Do not silently switch stacks.


## Compiler configuration

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch` and `forceConsistentCasingInFileNames` are true. Core targets ES2022 with no DOM library. Browser packages use ES2022 + DOM; Node packages use Node types. Use explicit `.js` import suffixes in emitted ESM paths and TypeScript project references. No implicit `any`, `@ts-ignore`, untyped evaluator escape hatch or CommonJS fallback in core.

Test code may use Node built-ins; portable packages may not import `node:*`. Architecture tests enforce this and prohibit React/CodeMirror in reader/export bundles. Dependency license compatibility and notices are checked before release; a dependency is not safe simply because its name appears in this table.

## Sources

See `docs/SOURCES.md`: S01–S12, S15–S18. External documentation supports the tools' capabilities; the architecture above is this project's decision, not a claim those projects implement Tinta.
