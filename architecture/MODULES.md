# Module and data-flow contract

## Workspace packages

```text
packages/
  types/          @tinta/types       spans, AST/IR, diagnostics, public DTOs
  syntax/         @tinta/syntax      Markdown profile, Tinta tokens, expression parser
  engine/         @tinta/engine      binding, types, DAG, evaluation, chart preparation
  charts/         @tinta/charts      pure chart scene geometry, SVG-safe primitives
  reader/         @tinta/reader      safe DOM mounting, focus, control and chart interaction
  artifacts/      @tinta/artifacts   source bundles, snapshots, HTML serialization
  cli/            @tinta/cli         filesystem adapters, command interface
apps/
  studio/         @tinta/studio      local reference editor
conformance/                      inputs and expected semantics
schemas/                          interchange envelope definitions
```

Dependencies form a DAG: types → syntax → engine; types/engine → charts; engine/charts → reader; syntax/engine/charts → artifacts; artifacts/engine → cli; public packages → studio. Here an arrow means “is a prerequisite for”. `reader` may use shared serialization utilities from `artifacts` only if those utilities are moved into a separate leaf `types` helper; do not create a cycle. `artifacts` embeds the already-built reader IIFE as bytes, never imports React.

Only the CLI file boundary and the shared `@tinta/local-files` Node adapter may access granted filesystem paths. CLI and the VS Code host supply explicit bounded file/root grants; Workspace Trust is never a directory grant. Studio sees only files chosen by the user. Pure packages receive text, bytes, typed records and explicit options; no ambient path, locale, clock, random values or network. Core never calls `fetch`, `localStorage`, IndexedDB or Node fs.

## Pipeline

```text
UTF-8 source + selected profile
  -> lossless source index / Markdown+Tinta syntax tree
  -> bind names + infer types + validate properties and schemas
  -> dependency graph + typed serializable program
  -> candidate control state
  -> evaluated symbols/views + visible document render plan
  -> prepared chart data -> SVG scene geometry
  -> DOM reader OR deterministic static HTML serializer
```

A structured program contains no closures, generated JavaScript, DOM nodes or unresolved imports. `contracts/public-api.d.ts` defines integration boundaries. Compiled artifacts are internal to the matching engine build; the public portable contract is source plus resources, not arbitrary serialized private AST layouts.

## Compiler stages and diagnostics

Decode strictly, enforce byte limits, parse Markdown and Tinta, parse expressions, collect declarations, resolve names, resolve table/view schemas, type-check, build dependency edges, detect strongly connected components, evaluate constants, validate control defaults/options, construct immutable program. Do not render before compilation succeeds. Every diagnostic has source URI, original UTF-16 half-open offsets, 1-based line/column, stable code, phase, message and optional related spans. Preserve offsets through import edits and recursive block parsing.

Collect up to the diagnostic limit. Deterministic ordering is phase, start offset, code. Suppress derivative diagnostics for a node with a fatal parse error. A reference to an unknown name does not generate an additional spurious cycle error.

## Session lifecycle

`createSession(program)` evaluates the author's initial controls. `setControl` or `setControls` clones a candidate state and evaluates it once. On success, commit a monotonically increasing revision and notify subscribers exactly once. On failure, discard the candidate and return diagnostics, leaving values, computed data, DOM and focus at the previous revision. No subscriber sees a partial revision.

A reader view is a projection, not a source editor. The chart presenter may keep focus, inspection and legend state locally. None of that enters the dependency graph or mutates source. Closing a reader unsubscribes listeners, observers, workers, blob URLs and timers. Mounting twice on the same host first requires explicit destruction of the old mount.

## Worker architecture

Studio compiles candidate edits in a dedicated Web Worker. Its worker bundle is embedded and loaded as a Blob URL in the standalone editor. The engine itself remains callable without workers. Requests carry protocol version, document instance ID and revision; results for stale revisions are ignored. Cancelled work is abandoned, not applied. The main thread terminates/recreates a worker when the watchdog expires and presents an explicit diagnostic.

The preview runs in an opaque-origin sandboxed iframe. Transfer only the validated program payload, explicit selected assets and messages permitted by `contracts/worker-protocol.d.ts`. No source document can request host file access, storage, clipboard writes, navigation or script execution. Initialization uses a MessageChannel and a cryptographically random host-generated capability token. Match `event.source` for the initial handshake; do not trust the string `origin === "null"` by itself.

The standalone exported reader has no compiler worker and no editor. It receives a validated program produced at export time, validates the envelope and resource limits again, then evaluates bounded expressions on the main thread. Source included for portability is inert, not reparsed as JavaScript. The lack of an editor worker in exports is not permission to remove operation limits.

## Failure boundaries

An invalid text edit retains the last valid preview with an unmistakable stale banner and disabled export. That preview's controls are disabled to prevent the user mistaking old state for the invalid source's state. Fixing source resumes preview with state reconciliation defined in the editor contract. A runtime reader failure affects that document instance, not another open document. Resource resolution failure never falls back to a remote fetch.

## Build outputs

Core packages: ESM JavaScript and declarations. Reader: one classic IIFE and one stylesheet, plus generated license notices. Worker: one classic bundled worker script. Studio: a chunked Vite + React static application under `build/studio/`, loopback development/preview, and an additional portable `tinta-studio.html` with embedded application, worker and preview resources. Application modules are served from the same static origin; document content cannot fetch resources. No runtime CDN, source maps with private local paths, or remote fonts. Static/interactive document exports contain no source maps or editor payload.

The build also emits `build/preview.html` as the supported, framework-free opaque preview shell and `build/preview-runtime.json` with its protocol, exact script/style CSP hashes, HTML SHA-256 and input inventory. It is the same shell embedded in Studio. Native adapters consume these generated outputs rather than private Studio modules. The manifest describes trusted build inputs; it does not validate authored programs or grant resource access. Hosts must preserve the sandbox and transport contract, including the inherited script hash.

## Native editor adapters

The [VS Code host contract](../docs/13_VSCODE.md) adds these separate owners:

| Owner | Dependencies and authority |
|---|---|
| `@tinta/language-service` | types, syntax, engine; pure analysis and query DTOs, no host APIs. |
| `@tinta/language-server` | types, language-service; local LSP scheduling and worker supervision, no asset/filesystem/network authority. |
| `@tinta/local-files` | types, artifacts; explicit Node file capabilities shared by CLI and native host. |
| `@tinta/vscode` | types, language-service, local-files, artifacts; local VS Code document adapter, client and grants. |
| VS Code browser entry | types, engine, reader, artifacts; separate `src/webview` subtree with no Node, VS Code API import, React or CodeMirror. |

The local-files adapter currently provides only exact opened-source reads; broader shared CLI/file workflows remain separate. The architecture checker inspects each as soon as its directory exists and forbids browser imports across its subtree. Existing required owners remain mandatory. Shared file extraction preserves CLI behavior; this boundary does not authorize arbitrary Node imports in language or browser packages. Only the native host loads the fixed bundled language server; no workspace-selected executable. Pure ESM stays intact. Trusted browser bundles remain classic scripts. The probe runner uses an isolated CommonJS test-loader shim; it does not convert engine packages to CommonJS. Product activation uses native ESM. The bundled upstream LSP SDK is CommonJS and receives a fixed Node createRequire shim in the extension/server bundles only; this does not permit author-selected imports or a CommonJS fallback in portable packages.
