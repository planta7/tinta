# Requirements-to-expectations traceability

This is a navigation map, **not exhaustive rule-level coverage or implementation evidence**. The seed corpus contains 98 expected semantic cases and 46 integrated/manual scenarios. Each normative clause, error code and boundary needs its own expanded test coverage as the owning milestone is implemented. A complete area row does not mean every rule inside the linked document has been tested.

| ID | Normative area | Seed cases | Scenarios | Full area gate |
|---|---|---:|---:|---|
| REQ-01 | [Markdown compatibility and explicit enrichment](../spec/01_MARKDOWN_AND_LEXING.md) | 10 | 1 | M1 |
| REQ-02 | [Tokens, blocks, options, spans and root scope](../spec/01_MARKDOWN_AND_LEXING.md) | 13 | 1 | M1 |
| REQ-03 | [Strict types, operators, graph and function evaluation](../spec/02_EXPRESSIONS_AND_STATE.md) | 19 | 0 | M2 |
| REQ-04 | [Metadata-defined numeric presentation](../spec/02_EXPRESSIONS_AND_STATE.md) | 2 | 0 | M2 |
| REQ-05 | [Control domains, transactions and lifecycle](../spec/02_EXPRESSIONS_AND_STATE.md) | 11 | 0 | M2 |
| REQ-06 | [Visibility versus static validation](../spec/03_DIRECTIVES.md) | 3 | 0 | M2 |
| REQ-07 | [Typed local data representation](../spec/04_DATA.md) | 8 | 0 | M2 |
| REQ-08 | [Shared immutable filters, sorting and aggregates](../spec/04_DATA.md) | 6 | 0 | M2 |
| REQ-09 | [Seven chart data/geometry/inspection contracts](../spec/05_CHARTS.md) | 15 | 7 | M4 |
| REQ-10 | [Linked scalar selection without hidden state mutation](../spec/05_CHARTS.md) | 5 | 0 | M4 |
| REQ-11 | [Local CSV/JSON schema import](../spec/04_DATA.md) | 6 | 1 | M6 |
| REQ-12 | [Source, assets, bundles and answer snapshots](../docs/02_FILES_AND_EXPORTS.md) | 0 | 4 | M5 |
| REQ-13 | [Independent interactive and minimized static artifacts](../docs/02_FILES_AND_EXPORTS.md) | 0 | 6 | M7 |
| REQ-14 | [Untrusted-source, IR, archive and preview boundaries](../docs/04_SECURITY.md) | 0 | 9 | M7 |
| REQ-15 | [Local editing, saving, recovery and worker behaviour](../docs/03_EDITOR_AND_READER.md) | 0 | 8 | M6 |
| REQ-16 | [Keyboard, assistive technology and document-first design](../docs/05_ACCESSIBILITY_AND_DESIGN.md) | 0 | 3 | M7 |
| REQ-17 | [Explicit filesystem command contracts](../docs/06_CLI.md) | 0 | 2 | M5 |
| REQ-18 | [Bounded work and measured resource budgets](../docs/07_VERIFICATION.md) | 0 | 2 | M7 |
| REQ-19 | [Reproducible tooling and honest release evidence](../docs/07_VERIFICATION.md) | 0 | 2 | M7 |

The machine-readable references are in [requirements.json](requirements.json). Execution evidence belongs under reports/verification, not in source expectations.
