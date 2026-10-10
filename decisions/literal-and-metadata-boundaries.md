# Literal, label and metadata boundaries

The source target remains 1.0; these changes advance the contract from draft 2 to draft 3 before stabilization. They do not declare a stable release.

Static options use literal tokens, without grouping parentheses around scalars, lists or list items. Numeric signs touch their numeric token. A selection binding is a bare identifier. Expression positions retain grouping. This aligns static options with the existing control-initial syntax and rejects formerly accepted grouped option values; no constant-expression evaluation is added.

Effective control labels and details summaries must remain nonempty after ECMAScript `String.prototype.trim`. Validation does not trim the displayed value. An underscore-only control name needs an explicit nonblank label. Invalid effective labels report `E_PROPERTY_VALUE`; this closes the mismatch with the persistent visible-label and accessible-name requirement.

Metadata may follow only blank lines and HTML comments. Markdown reference definitions are content for this placement rule. They remain non-rendered for block-content checks and retain their ordinary document-wide link scope. Metadata after a reference definition reports `E_META_POSITION`.

The directive examples use `readings` instead of the reserved column name `count`. Reserved identifiers and the function set are unchanged. The source version and IR ABI identifiers are unchanged; the exact contract revision in compiled IR advances, so old compiled payloads must be recompiled from source.

These are source acceptance restrictions, not new execution capabilities. Existing source must fix blank labels, grouped static values or late metadata before compilation under this revision. Regressions belong to `tests/unit/language-boundaries.test.mjs` and the existing syntax, engine and schema contracts.
