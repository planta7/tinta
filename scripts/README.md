# Specification and contract checks

Run from the repository root, with Python 3.9 or newer:

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_contracts.py
```

Both checker scripts also work by absolute path from any current directory. Their default output is stdout/stderr; no input files are changed. Optional machine-readable reports use a caller-selected path:

```sh
python3 scripts/check_spec.py --report reports/validation/spec.json
python3 scripts/check_contracts.py --report reports/validation/contracts.json
```

`check_spec.py` uses only the standard library. It checks explicitly enumerated public roots, required files, strict JSON, registry counts and names, grammar coverage, relative links and heading anchors, case IDs/expectations/diagnostics, requirement authorities and traceability, source-state hashes, and canonical ZIP/PNG integrity. It does not follow symlinks or read unrelated local files. It does not fetch external links. Missing or malformed public inputs return nonzero.

`check_contracts.py` additionally requires TypeScript's `tsc` on PATH and the Python `jsonschema` package (Draft 2020-12, with its `referencing` dependency). It compiles the declarations and checks schemas plus positive/negative envelopes. Missing prerequisites return nonzero with explicit diagnostics. These ambient tools are not a verified project dependency graph. The workspace resolves the selected TypeScript line and repeats schema checks with locked Ajv. No global tool installation is required or performed by these scripts.

The regression suite uses temporary public copies and destructive negative fixtures within those copies. None of these checks executes a Tinta parser, evaluator, browser, CLI or semantic IR decoder. The implementation gates are documented in the [engine API](../docs/11_ENGINE_API.md). The application test commands and dependency lock are defined in the [roadmap](../docs/ROADMAP.md) and [stack](../architecture/STACK.md).

## Candidate qualification

`pnpm test:hardening` runs every seeded property with 10,000 inputs while retaining its committed seed. The normal test gate uses 1,000 inputs. Other counts are rejected. `pnpm benchmark` creates deterministic small, medium, large, dense and 32,000-mark sources, records their hashes, and measures production browser code with 10 warm-ups and 50 measured runs. It also records fresh-context samples, retained heap, isolated worker completion and Studio interaction latency. Studio uses three independent contexts and records typing feedback, dependent control updates, preview completion and long-task diagnostics under the [interaction protocol](../docs/07_VERIFICATION.md#studio-interaction-protocol). It avoids DOM polling during timed intervals; paint opportunities remain a laboratory proxy rather than a real-device presentation guarantee. Read every limitation in the resulting report; a timing subset is not release acceptance.

`node scripts/qualification-package.mjs` builds a local review directory containing examples, source bundles, both HTML exports, Studio, reader files, notices and a source inventory. `node scripts/traceability.mjs` validates the reviewed mappings in `conformance/rule-coverage.json` against normative clauses, concrete test declarations, supporting inputs, diagnostic codes and registered limits. Missing or changed mappings return nonzero. `MAPPED` confirms mapping integrity only; it never means that tests ran or that manual acceptance passed.

`pnpm qualify` runs the aggregate checks, hardening, dependency audit, packaging and benchmarks. It writes `reports/verification/qualification/readiness.json` and returns nonzero until all required checks and external reviews are complete. `pnpm qualify --evidence review.json` additionally consumes reviewer records bound to the candidate commit and artifact manifest. Each review needs an identifier from `scripts/qualification-evidence.mjs`, status, reviewer, UTC timestamp, exact environment, procedure, observations and a record reference. Synthetic validator fixtures are never acceptance evidence. The candidate must remain unchanged throughout verification. A passing technical qualification never authorizes tagging, publication or distribution.
