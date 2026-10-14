# Conditional confirmation of installed native timing

## Measurement and interpretation

The timing targets in [the VS Code host contract](../docs/13_VSCODE.md) describe a particular installed build and host. A 30-sample p95 is the second slowest sample. Brief scheduling stalls can therefore change a timing result even when the other samples are well below the budget. A single exceeded target does not establish a reproducible regression or identify its cause.

Measure each analysis size, cached completion and host responsiveness once. A passing scenario needs no confirmation. A timing failure triggers exactly two further complete measurements of that scenario, including both confirmations when the second attempt passes. Each analysis or completion attempt keeps its existing warmup and 30 samples. Responsiveness attempts repeat the original timed workload: all three analysis sizes, cached completion and eight-document rapid editing. Use the same installed archive, profile and resident-memory collector; do not reinstall, restart the host or rebuild between attempts.

Assess each attempt against the unchanged numeric targets. One failing attempt out of three is `UNSTABLE`, retained in the report and emitted as a CI warning; CI may continue. Two or three failing attempts are `FAIL` and block CI. Keep all original values, raw analysis/completion samples and responsiveness p95, maximum and sample count. Responsiveness confirmation reports also retain the analysis/completion blocks performed as its workload. Never discard a slow sample, average attempts or retry until passing.

Functional assertion failures, watchdog expiry, collection errors and incomplete or invalid data block immediately. Retained heap and resident-memory limits keep their original single-run assessment and cannot be rescued by timing confirmation. A partial report preserves completed measurements if a later confirmation fails functionally.

## Compatibility and security

This changes the interpretation of installed timing tests, not source semantics, runtime scheduling, language limits, numeric performance targets or resource limits. Source format and protocol revisions are unchanged. An unstable result remains evidence of timing variability; it is not a claim that the host meets its target consistently. No additional product capability, telemetry or network access is introduced.
