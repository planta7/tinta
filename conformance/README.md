# Conformance expectations and adapter contract

These JSON records specify expected results. They are not execution reports. Every case/scenario begins `NOT_RUN`; never change that source expectation to PASS. Implementations write separate evidence reports under reports/verification.

## Semantic case phases

- `compile`: call compile using source/profile and assert the result. A false expectation must be rejected during compilation, not deferred to a browser.
- `initial`: compile, then createSession and inspect initial revision. A false expectation may fail at constant validation during compile or during initial evaluation, as appropriate to the diagnostic's phase; report the actual phase. Do not swallow a compile error to proceed.
- `transition`: compile and initialize successfully, apply the `update` map once, then compare both the action result and the retained/committed revision. Expected errors must occur on that update, not before it.
- `enrich`: call enrichMarkdown with Markdown profile; compare exact transformed source and edit count, then independently assert safe parse equivalence.
- `csv` / `json`: call the named local importer using UTF-8 bytes and importName. Compare schema/type order, row count or diagnostic; compile generated source on success.

Every `expect.ok` is mandatory. `code` means the result includes that diagnostic as its primary relevant failure; unexpected earlier errors fail the fixture. `values` and `controls` are asserted subsets, not permission to omit other required names from engine state. `revision` is the session revision after the operation. `rowCounts` compares named source/view row counts. `tableRows` compares ordered scalar cell arrays. `textContains`/`textExcludes` examine resolved visible text; they do not inspect source or hidden IR. Runtime executable behaviour flags such as noAuthorExecution/noActiveUnsafeLinks also require browser-level assertions and cannot be satisfied merely by matching a string.

`charts` matches figures in source-visible order. pointCount counts raw prepared points (row-major × series), yValues follow prepared point order, seriesCount is explicit series count. binEdges has B+1 boundaries; binCounts has B counts; empty is the prepared empty flag. Histogram points are empty and its bins hold frequencies. A pie/donut's points are its original categories, including zeros; geometry may have fewer nonzero wedges.

Numeric comparisons are exact for integers, controls and the specified decimal-grid conversion. General computed values may use `abs(actual-expected) <= max(1e-12, abs(expected)*1e-12)` for binary64/power cross-engine tests. This tolerance never changes language equality, control-domain validation or the error/rollback contract. String results compare exactly except documented locale NBSP variants in cross-ICU portability runs; the locked canonical en-US test environment uses exact strings.

## Coverage obligations

The supplied cases are a seed contract, not an exhaustive test suite. Every normative rule and diagnostic needs positive/negative/boundary coverage as stages land. `scenarios.json` describes additional integrated and manual gates. `requirements.json` maps normative areas to cases/scenarios; it is a trace map, not proof of implementation. M1 must additionally vendor and pin the official CommonMark corpus with its own license/attribution in a third_party directory; do not relabel it MIT.

Implement an adapter under conformance/runner that imports only the public SDK. A fixture must fail when its expected implementation does not exist. No success stubs, test-count fabrication, automatic expected-output acceptance or passWithNoTests. Record source fixture hash, engine build, environment, command and actual assertions in evidence. Tests that cannot run are NOT_RUN or BLOCKED, never PASS.
