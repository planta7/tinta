# Change control, compatibility and provenance

## Authority

The [product contract](01_PRODUCT.md) defines the supported scope. The normative language prose and its matching machine-readable registry/grammar/contracts define the implementation. Conflicting normative rules must be resolved before implementing the affected behavior. Describe the conflicting file/section, a minimal input that exposes the difference, proposed resolution, compatibility/security impact and affected tests in the issue or pull request, then update the relevant specification or technical reference. Never implement a guessed fallback and describe it as specified.

The language defines explicit behavior. Dependency compatibility, browser behavior and measured performance are properties of a particular build and environment. A change to normative behavior needs a technical decision and matching fixtures, with its compatibility and security impact stated explicitly.

## Versioning

`1.0-draft.3` identifies the language contract. `1.0` identifies the target source format; software versions are separate. The reference UI identifies the current contract as Draft. Package builds during development use `0.1.0-dev.<integer>`; the first such integer is 0 and increases only for an intentionally distributed build. A source file containing `version: "1.0"` does not identify the software release version.

Before stabilization, any grammar/semantic change increments the draft revision and updates the change record, registry, schemas, contracts, examples, expected tests and cheatsheet together. After source V1 stabilization, valid document meaning is preserved within source 1.x. New source semantics require explicit opt-in to a new supported format version; unknown future versions fail with E_VERSION. Tool package patch/minor updates may fix bugs/security without silently adding syntax under an existing source contract. IR is independently versioned by the exact ABI `tinta-ir-1`; unknown ABI is rejected, not guessed. Source bundles and answer snapshots have their own `formatVersion`.

V1 does not automatically interpret or migrate older syntax. Documents must use a supported contract revision; the parser rejects unsupported syntax without guessing its meaning. Files open through explicit selection; operating-system file associations require user consent. The project name and `.tinta` suffix do not imply exclusive rights or trademark clearance.

## Draft 3 syntax clarification

Contract draft 3 narrows inputs accepted by draft 2. Static options use literal tokens without grouping parentheses around scalars, lists or list items; numeric signs touch their number. Selection uses a bare identifier. Expression positions retain grouping, and static options do not gain constant-expression evaluation.

Effective control labels and details summaries must contain a character after ECMAScript `String.prototype.trim`, including labels generated from control names. Validation does not trim the displayed text. An underscore-only name needs an explicit nonblank label; invalid effective labels report `E_PROPERTY_VALUE`.

Metadata accepts only blank lines and HTML comments before it. Markdown link reference definitions count as content for placement and produce `E_META_POSITION` when followed by metadata. They remain non-rendered for block-content checks and retain their document-wide link scope.

The directive examples use `readings` instead of the reserved column name `count`; reserved identifiers and the function set are unchanged. Existing documents must correct grouped static values, blank labels and late metadata before compilation under draft 3. Source version 1.0 and IR ABI identifiers are unchanged, but compiled IR records the exact contract revision, so old compiled payloads must be recompiled from source. These restrictions add no execution capabilities and do not declare a stable language release. Regression coverage is in `tests/unit/language-boundaries.test.mjs`.

## Draft 2 identifier revision

The project is Tinta, with `.tinta` source, `.tinta.zip` bundles, the `tinta` profile and CLI, and `@tinta-lang/*` package names. Envelope discriminators, IR ABI and host protocol use the `tinta-` prefix. Source and envelope format versions remain 1.0; language semantics are unchanged.

## Licensing

The specification, implementation, reference editor, CLI, examples and original fixtures use MIT; see LICENSE. Third-party specifications, conformance suites, libraries and fonts retain their own licenses. Never replace a third-party notice with this project's license. Use system fonts; do not package proprietary font files.

The MIT license applies to the source regardless of whether a workspace manifest is marked `private`. The public SDK defines the integration boundary for applications using the engine.

Release archives and package file lists must explicitly include public inputs and exclude local configuration, credentials, and development outputs. Verify actual archive contents before distribution.

## Native editor integration

The [VS Code host](13_VSCODE.md) introduces portable editor-analysis DTOs and an independent outer webview protocol, `tinta-vscode-1`. It does not change source format 1.0, `tinta-ir-1`, `tinta-host-1`, source bundles or answer snapshots. The shared file adapter expands the host boundary to explicitly granted native editor operations without granting filesystem access to core packages. See [source identity and fidelity](13_VSCODE.md#source-identity-and-fidelity) for the native editor's line-ending limitation and separate-copy policy.

## Local extension artifact identity

The local VSIX uses development version `0.1.0-dev.0` and the internal installation identity `tinta-local.tinta`. Its generated manifest is separate from the private `@tinta-lang/vscode` workspace package. Workspace source versions remain `0.0.0`. Builds generate the embedded implementation version from `toolchain/release.json`, and interactive envelopes must exactly match their embedded reader. The build identity records both versions, contract revision, source hash, commit/dirty state and payload hashes. Repeated local builds retain the development version and are distinguished by hashes. The local extension and release extension have different installation identities; disable or uninstall the local extension before enabling the release extension to avoid duplicate providers.

## Software distribution groups

The [software distribution contract](15_DISTRIBUTION.md) defines public package and extension identities, a coordinated language-library version group, an independent Studio/CLI delivery version, independent numeric Marketplace versions, channels and closed release metadata. Source format and ABI versions remain separate from software versions.
