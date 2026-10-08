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
