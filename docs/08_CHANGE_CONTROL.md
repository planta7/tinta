# Change control, compatibility and provenance

## Authority

The approved product boundaries are in DECISIONS.md. The normative language prose and its matching machine-readable registry/grammar/contracts define the implementation. A normative conflict is a defect in this package, not an invitation to choose whichever rule is easier. Open a decision record under decisions/ with the conflicting file/section, a minimal input that exposes the difference, proposed resolution, compatibility/security impact and affected tests. Never implement a guessed fallback and describe it as specified.

The language defines explicit behavior. Dependency compatibility, browser behavior and measured performance are properties of a particular build and environment. A change to normative behavior needs a technical decision and matching fixtures, with its compatibility and security impact stated explicitly.

## Versioning

`1.0-draft.2` is the revision of this design package. `1.0` is the target source-format version, not evidence that a stable implementation exists. The reference UI identifies the current contract as Draft. Package builds during development use `0.1.0-dev.<integer>`; the first such integer is 0 and increases only for an intentionally distributed build. Do not publish or claim a stable 1.0 release simply because a source file contains `version: "1.0"`.

Before stabilization, any grammar/semantic change increments the draft revision and updates the change record, registry, schemas, contracts, examples, expected tests and cheatsheet together. After source V1 stabilization, valid document meaning is preserved within source 1.x. New source semantics require explicit opt-in to a new supported format version; unknown future versions fail with E_VERSION. Tool package patch/minor updates may fix bugs/security without silently adding syntax under an existing source contract. IR is independently versioned by the exact ABI `tinta-ir-1`; unknown ABI is rejected, not guessed. Source bundles and answer snapshots have their own `formatVersion`.

No automatic runtime interpreter for historical syntax is required. Do not overload a new parser with ambiguous legacy guesses. An old document can be migrated by a separate explicit tool later, but that is outside V1. File associations are opt-in; `.tinta` is a project convention, not a claim that no other tool uses that suffix.

## Draft 2 identifier revision

The project is Tinta, with `.tinta` source, `.tinta.zip` bundles, the `tinta` profile and CLI, and `@tinta/*` internal workspace identities. Envelope discriminators, IR ABI and host protocol use the `tinta-` prefix. Source and envelope format versions remain 1.0; language semantics are unchanged.

## License and commercial separation

The specification, implementation, reference editor, CLI, examples and original fixtures use MIT; see LICENSE. Third-party specifications, conformance suites, libraries and fonts retain their own licenses. Never replace a third-party notice with this project's license. Use system fonts; do not package proprietary font files.

Future proprietary product work belongs in a separate repository and depends on the open engine through the public API. No commercial-only code, secrets, billing/accounts or artificial open-engine limits are added here. Keeping workspace packages `private: true` prevents accidental npm publication; it does not make the repository's MIT-licensed content proprietary. Public hosting, registration, releases and namespace availability remain explicit owner actions outside automated implementation.

Release archives and package file lists must explicitly include public inputs and exclude local configuration, credentials, and development outputs. Verify actual archive contents before distribution.
