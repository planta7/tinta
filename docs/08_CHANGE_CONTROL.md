# Change control, compatibility and provenance

## Authority

The approved product boundaries are in DECISIONS.md. The normative language prose and its matching machine-readable registry/grammar/contracts define the implementation. Conflicting normative rules must be resolved before implementing the affected behavior. Open a decision record under decisions/ with the conflicting file/section, a minimal input that exposes the difference, proposed resolution, compatibility/security impact and affected tests. Never implement a guessed fallback and describe it as specified.

The language defines explicit behavior. Dependency compatibility, browser behavior and measured performance are properties of a particular build and environment. A change to normative behavior needs a technical decision and matching fixtures, with its compatibility and security impact stated explicitly.

## Versioning

`1.0-draft.3` is the revision of this design package. `1.0` is the target source-format version, not evidence that a stable implementation exists. The reference UI identifies the current contract as Draft. Package builds during development use `0.1.0-dev.<integer>`; the first such integer is 0 and increases only for an intentionally distributed build. Do not publish or claim a stable 1.0 release simply because a source file contains `version: "1.0"`.

Before stabilization, any grammar/semantic change increments the draft revision and updates the change record, registry, schemas, contracts, examples, expected tests and cheatsheet together. After source V1 stabilization, valid document meaning is preserved within source 1.x. New source semantics require explicit opt-in to a new supported format version; unknown future versions fail with E_VERSION. Tool package patch/minor updates may fix bugs/security without silently adding syntax under an existing source contract. IR is independently versioned by the exact ABI `tinta-ir-1`; unknown ABI is rejected, not guessed. Source bundles and answer snapshots have their own `formatVersion`.

No automatic runtime interpreter for historical syntax is required. Do not overload a new parser with ambiguous legacy guesses. An old document can be migrated by a separate explicit tool later, but that is outside V1. File associations are opt-in; `.tinta` is a project convention, not a claim that no other tool uses that suffix.

## Draft 3 syntax clarification

Static options use ungrouped literals and selection uses a bare identifier. Control labels and details summaries must not be blank, including generated control labels. Metadata accepts only blank lines and comments before it; link reference definitions count as content. The reserved column name in the directive examples is corrected to `readings`. These changes narrow previously accepted draft inputs; source version 1.0 is still a target, not a stable release declaration.

## Draft 2 identifier revision

The project is Tinta, with `.tinta` source, `.tinta.zip` bundles, the `tinta` profile and CLI, and `@tinta-lang/*` internal workspace identities. Envelope discriminators, IR ABI and host protocol use the `tinta-` prefix. Source and envelope format versions remain 1.0; language semantics are unchanged.

## Licensing

The specification, implementation, reference editor, CLI, examples and original fixtures use MIT; see LICENSE. Third-party specifications, conformance suites, libraries and fonts retain their own licenses. Never replace a third-party notice with this project's license. Use system fonts; do not package proprietary font files.

The MIT license applies to the source regardless of whether a workspace manifest is marked `private`. The public SDK defines the integration boundary for applications using the engine.

Release archives and package file lists must explicitly include public inputs and exclude local configuration, credentials, and development outputs. Verify actual archive contents before distribution.

## Native editor integration

The [VS Code host](13_VSCODE.md) introduces portable editor-analysis DTOs and an independent outer webview protocol, `tinta-vscode-1`. It does not change source format 1.0, `tinta-ir-1`, `tinta-host-1`, source bundles or answer snapshots. The shared file adapter expands the host boundary to explicitly granted native editor operations without granting filesystem access to core packages. See [the source-fidelity decision](../decisions/native-editor-source-fidelity.md) for the native editor's line-ending limitation and separate-copy policy.

## Local extension artifact identity

The local VSIX uses development version `0.1.0-dev.0` and the internal installation identity `tinta-local.tinta`. Its generated manifest is separate from the private `@tinta-lang/vscode` workspace package. Workspace source versions remain `0.0.0`. Builds generate the embedded implementation version from `toolchain/release.json`, and interactive envelopes must exactly match their embedded reader. The build identity records both versions, contract revision, source hash, commit/dirty state and payload hashes. Repeated local builds retain the development version and are distinguished by hashes. No intentional distribution, version increment, Marketplace identity or publication is implied by creating or testing a local archive.

## Coordinated software distribution

The [software distribution contract](15_DISTRIBUTION.md) defines public package and extension identities, an implementation version group, independent numeric Marketplace versions, channels and closed release metadata. Source format and ABI versions remain separate from software versions.
