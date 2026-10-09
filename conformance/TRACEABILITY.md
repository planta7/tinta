# Requirements-to-expectations traceability

The area table below preserves the navigation through 98 semantic seed cases and 46 integrated scenarios. [rule-coverage.json](rule-coverage.json) expands that map into normative prose blocks, exact diagnostic codes and registered resource values. Each entry describes its expected assertion and identifies concrete test declarations or a behavior inspection. A paragraph may contain multiple obligations; mapping integrity alone cannot establish semantic completeness.

Run `node scripts/traceability.mjs` to detect missing clauses, changed assertions or test context, unknown references, omitted diagnostics and changed limit values. Test and supporting-input hashes must match their definitions. The command checks mapping integrity; it does not execute the mapped tests.

Boundary entries distinguish integrated behaviour, internal counters, container parsing, defaults, deadlines and eviction policies. A counter-level test does not claim that an entire document or archive at that size is valid.

| ID | Normative area | Seed cases | Scenarios |
|---|---|---:|---:|
| REQ-01 | [Markdown compatibility and explicit enrichment](../spec/01_MARKDOWN_AND_LEXING.md) | 10 | 1 |
| REQ-02 | [Tokens, blocks, options, spans and root scope](../spec/01_MARKDOWN_AND_LEXING.md) | 13 | 1 |
| REQ-03 | [Strict types, operators, graph and function evaluation](../spec/02_EXPRESSIONS_AND_STATE.md) | 19 | 0 |
| REQ-04 | [Metadata-defined numeric presentation](../spec/02_EXPRESSIONS_AND_STATE.md) | 2 | 0 |
| REQ-05 | [Control domains, transactions and lifecycle](../spec/02_EXPRESSIONS_AND_STATE.md) | 11 | 0 |
| REQ-06 | [Visibility versus static validation](../spec/03_DIRECTIVES.md) | 3 | 0 |
| REQ-07 | [Typed local data representation](../spec/04_DATA.md) | 8 | 0 |
| REQ-08 | [Shared immutable filters, sorting and aggregates](../spec/04_DATA.md) | 6 | 0 |
| REQ-09 | [Seven chart data/geometry/inspection contracts](../spec/05_CHARTS.md) | 15 | 7 |
| REQ-10 | [Linked scalar selection without hidden state mutation](../spec/05_CHARTS.md) | 5 | 0 |
| REQ-11 | [Local CSV/JSON schema import](../spec/04_DATA.md) | 6 | 1 |
| REQ-12 | [Source, assets, bundles and answer snapshots](../docs/02_FILES_AND_EXPORTS.md) | 0 | 4 |
| REQ-13 | [Independent interactive and minimized static artifacts](../docs/02_FILES_AND_EXPORTS.md) | 0 | 6 |
| REQ-14 | [Untrusted-source, IR, archive and preview boundaries](../docs/04_SECURITY.md) | 0 | 9 |
| REQ-15 | [Local editing, saving, recovery and worker behaviour](../docs/03_EDITOR_AND_READER.md) | 0 | 8 |
| REQ-16 | [Keyboard, assistive technology and document-first design](../docs/05_ACCESSIBILITY_AND_DESIGN.md) | 0 | 3 |
| REQ-17 | [Explicit filesystem command contracts](../docs/06_CLI.md) | 0 | 2 |
| REQ-18 | [Bounded work and measured resource budgets](../docs/07_VERIFICATION.md) | 0 | 2 |
| REQ-19 | [Reproducible tooling and distribution contents](../docs/07_VERIFICATION.md) | 0 | 2 |

The machine-readable references are in [requirements.json](requirements.json). The corpus defines expected behavior; observed results are separate generated outputs.
