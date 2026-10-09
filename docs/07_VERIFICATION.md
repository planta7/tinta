# Verification, performance, CI and release gates

## Evidence hierarchy

Package checks validate this documentation package only. Semantic conformance checks validate the implementation on the supplied/new cases. Browser automation validates specified browser behaviours. Manual review validates actual visual/assistive-tech/browser-device experience. None substitutes for another.

The release gate requires every accepted V1 normative rule to have an identifiable test or recorded manual inspection. Use conformance/requirements.json and expand it when fixing a genuine uncovered rule. A test must not be removed, skipped or weakened to get a green run. Coverage numbers supplement semantic assertions; they do not define correctness.

## Required suite groups

**Parser:** complete pinned CommonMark 0.31.2 corpus in Markdown profile, individual supported extension cases, every directive/token/escape/multiline rule, all ineligible interpolation contexts, Unicode/BOM/CRLF source spans, unknown commands and error recovery. Compare parse structure separately from safe-render policy; no broad exemption of raw-HTML-containing inputs from parsing conformance.

**Semantics:** type matrix, functions/arity/domains, forward constants, constant restrictions, root scopes, duplicate/reserved/unknown names, cycles spanning calculations/views, short-circuit versus static validation, all controls and exact decimal grids, candidate rollback, state baseline/reset and observer lifecycle.

**Data/charts:** typed rows, quoted delimiters/newlines, stable chained filtering/sorting, empty schemas/aggregates, each chart’s type matrix, numeric domains, negative/zero values, ordering, duplicate x, all selection mappings, histogram boundaries/conservation, legend-only state, hidden selection and responsive scene geometry. Property tests cover histogram count conservation and view stability.

**Artifacts/IO:** source fidelity, bundle canonicalization, duplicate-key/path/CRC/hash/decompression rejection, all raster types and malicious images, image capability boundaries, state fingerprints, selected-answer exports, static hidden-data omission, source/payload escaping, actual file:// opening, output existence/atomicity/cancellation and cross-platform CLI argument handling.

**Editor/reader:** worker revisions/timeouts, dirty buffer flow, automatic draft restoration, recovery opt-out/quota errors, reference editor standalone opening, file API fallbacks, semantic diagnostics source selection, state reconciliation, imported data/image undo, valid/invalid/stale preview states, focus and no unexpected network.

**Security/accessibility:** all scenarios in security/design contracts, fixed exploit regressions, operation/resource limits, no author execution, no surprise remote requests, safe SVG and opaque preview tests, axe checks and named manual assistive-technology/device runs.

## Coverage and property-test policy

For syntax/engine: at least 95% statements and 90% branches, including every diagnostic family. For charts/artifacts: at least 90% statements and 85% branches. UI scaffolding/CLI: at least 85% statements and 80% branches. Generated type declarations and vendored third-party code are excluded with an explicit path list; project error paths are not excluded. A coverage threshold is not permission to omit an identified rule.

Run deterministic fast-check seeds in CI: 1000 generated inputs per mandatory property per PR, 10000 per property in final hardening. Commit seed and minimal regression for each found failure. Fuzz malformed source, nested expression/Markdown structure, CSV/JSON, snapshot maps, bundle metadata and messages. Every named numeric limit needs at-limit and limit+1 tests. Wall-clock watchdog tests use controlled fake scheduling or isolated workers, not flaky “should be fast” assertions.

## Browser and platform matrix

Each PR: Node pinned baseline on Linux; semantic/unit/type/architecture/package checks; Chromium/Firefox/WebKit automation on pinned Playwright builds. Full final gate: CLI tests on macOS arm64, Linux x64 and Windows x64, plus file:// exports in the three engines. Record the exact Playwright package and browser revisions, not just browser-family labels. WebKit automation is not actual Safari and does not close the manual Safari gate.

At M7 record real macOS Safari + VoiceOver, Windows Firefox + NVDA, and real iOS Safari reader behaviour. A missing manual environment remains BLOCKED. Do not publish V1 and quietly describe that environment as “probably works”. A development draft may be distributed explicitly without the unsupported claim, only with owner authorization.

## Performance corpus and budgets

Use deterministic generated documents, commit their generator seeds and final hashes. Corpus S: 20KiB prose, 5 controls, 100 data rows, 3 figures. Corpus M: 200KiB prose, 20 controls, 5000 source rows across tables, 100000 cells maximum, 8 figures each <=1000 rows/series limits. Corpus L: source at 2MiB and near declaration/AST/table limits without violating any; used primarily for bounded completion/cancellation, not instant UI promises. Include a dense 6-series 2000-row scatter at the per-figure limit and a 32k total mark transaction.

Qualification reference: macOS arm64 machine with >=16GiB RAM, no artificial CPU throttle, plugged in; record exact CPU, OS, power mode and browser. Warm measurements: 10 warm-up runs then 50 measured runs, no dev server/HMR, median and p95. Cold opening: 10 fresh contexts. Exclude browser startup from language compile timing but include parsing in cold document evaluation. Maintain separate compile, evaluate, SVG preparation, DOM commit and export timings.

Targets on the reference machine: S initial compile+evaluate p95 <=150ms; M <=750ms; S answer update p95 <=50ms; M <=150ms; dense figure preparation+DOM update p95 <=250ms; valid L completes or reports a documented limit within 3s worker watchdog without source loss; export <=2s for M excluding an OS save dialog; incremental retained heap after 100 mount/destroy cycles <=10MiB above stabilized baseline. Studio responsiveness follows the interaction protocol below; compilation runs in a worker. Standalone reader operation budgets remain mandatory even if a large input cannot meet the small-document target.

### Studio interaction protocol

For the medium corpus, run three fresh browser contexts. In each context measure
source typing and a dependent chart control separately, with 10 warm-up actions
and 50 measured actions per scenario. Use the production offline artifact on the
reference machine. Each run must meet all of these budgets:

| Metric | Acceptance budget | Purpose |
|---|---|---|
| Typing event to editor paint opportunity, p95 | <=100ms | Prompt feedback while writing |
| Control event to updated reader paint opportunity, p95 | <=150ms | Preserve the medium answer-update budget |
| Typing event to updated preview paint opportunity, p95 | <=1000ms | Include the 200ms debounce, worker work and presentation |
| Maximum observed main-thread task during either scenario | <=200ms | Reject severe individual stalls even with a good p95 |

A paint opportunity is measured conservatively by two consecutive animation-frame
callbacks after the relevant DOM update. It is a laboratory proxy, not proof of
pixels being presented or a field Interaction to Next Paint score. Record event
timestamps, completion timestamps, raw samples, median, p95 and maximum. Preview
completion must observe the changed document, not merely the worker response.
Verify control values and source edits after measurement. Missing events, missing
observer support, timeouts and incomplete samples fail the measurement.

Keep 50ms as the diagnostic long-task target. Report long-task count, maximum,
excess time above 50ms, and the fraction of actions containing a long task; do not
silently discard outliers. Record browsing-context attribution without claiming
it identifies individual product functions. Avoid automation DOM polling during
timed intervals. Preserve all three runs, including failures; do not retry until
a passing run appears. A failed run blocks acceptance pending investigation.

These are engineering budgets chosen before evaluation, not thresholds derived
from the current implementation's results. The one-second preview budget does
not replace the existing compile/evaluate or reader-update budgets. See the
[responsiveness decision](../decisions/studio-responsiveness.md) for rationale,
measurement limits and the superseded absolute 50ms criterion.

Bundle ceilings: portable core+syntax+engine <=500KiB gzip, reader+charts <=350KiB gzip excluding document payload/assets, standalone Studio <=3MiB gzip excluding bundled example raster fixtures. Report actual minified/gzip bytes and dependency composition. These are engineering targets to prove or explicitly block on, not performance measured without measurements. Do not silently lift ceilings or claim success based on estimated sizes.

## CI sequence

Install exact Node/pnpm; pnpm install --frozen-lockfile; documentation/registry validation; formatting/lint; strict typecheck; architecture import graph; unit/conformance/property tests; build all artifacts; browser tests including file://; schema/source-bundle verification; license/audit inventory; coverage and size reports. On release candidate add cross-platform CLI, fuzz limits, benchmarks and manual checklist references. Pin CI actions to full reviewed SHAs. Do not upload user documents to CI; all fixtures are synthetic.

Run npm/pnpm vulnerability audit against the locked graph in M0 and before release. A critical/high unmitigated applicable production dependency issue blocks release. An audit endpoint outage is NOT_RUN, not “0 vulnerabilities”. Evaluate dev-only advisories with their actual attack surface and document the disposition. No automatic dependency major updates.

## Evidence records

Each milestone evidence directory has SUMMARY.md, environment.json, commands.json, test-results.json and its relevant artifacts. Records include UTC timestamp, git commit (or UNCOMMITTED with tree hash), source fixture hashes, exact commands/exit codes, passed/failed/skipped counts, browser revisions and manual reviewer notes. Screenshots use synthetic example content. Empty test output, mere file existence or a build exit code cannot be counted as semantic tests.

A gate status is NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, BLOCKED or PASS. PASS requires all that milestone’s mandatory checks and no undisclosed skipped/unrun gate. Final release needs owner acceptance of manual checks and an explicit authorization to tag/publish; build success never authorizes repository/package publication.
