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

The regression suite uses temporary public copies and destructive negative fixtures within those copies. None of these checks executes a Tinta parser, evaluator, browser, CLI or semantic IR decoder. The [engine API](../docs/11_ENGINE_API.md) describes the runtime suites. See [testing and performance](../docs/07_VERIFICATION.md) for test scope and [the stack](../architecture/STACK.md) for dependency constraints.

## Runtime tests and benchmarks

`pnpm test:hardening` runs each deterministic property with 10,000 inputs and its committed seed. Ordinary property runs use 1,000 inputs; other counts are rejected. The [test reference](../docs/07_VERIFICATION.md) describes suite scope, coverage requirements and resource boundaries.

`pnpm benchmark` generates deterministic small, medium, large, dense and 32,000-mark documents, records source hashes, and measures production browser code. Measurements include 10 warm-ups and 50 samples, fresh-context opening, retained heap, worker completion and Studio interaction latency. The [Studio interaction protocol](../docs/07_VERIFICATION.md#studio-interaction-protocol) defines the three-context procedure, paint-opportunity proxy and timing limitations.

`node scripts/traceability.mjs` checks normative clause mappings, concrete test declarations, supporting inputs, diagnostic codes and registered limits. Missing or changed mappings return nonzero. Mapping integrity is distinct from executing a test or observing behavior with assistive technology.

Build and test outputs live under ignored `build/` and `reports/` directories. They use synthetic documents and do not read private local instructions. Public commands work from a checkout without Git history or private progress records unless their documented operation explicitly inspects the repository revision.

## Local VS Code artifact

`pnpm package:vscode` rebuilds and creates `build/vscode/tinta-0.1.0-dev.0.vsix` with an explicit archive allowlist and byte hashes. Packaging reads the Git revision and current public source inventory. It uses the existing locked artifact ZIP dependency and adds no package-manager or publication tool. The installed manifest has the internal identity `tinta-local.tinta`; workspace packages remain private. The catalog and preview are embedded in the runtime bundles.

`pnpm verify --suite vscode` combines static checks, coverage, conformance, preview browser tests and native installed-extension checks on the current machine. Set `TINTA_VSCODE_EXECUTABLE` to the pinned desktop executable and `TINTA_VSCODE_CLI` to its command-line launcher. Missing prerequisites or any mandatory child failure return nonzero. Provision the desktop and browser binaries before running offline. No unavailable platform is inferred from another platform.

`node scripts/test-vscode-installed.mjs DESKTOP CLI VSIX FRESH_DIRECTORY` installs the actual archive into separate user, extension and shared-data directories. Add `--restricted` for Restricted Mode, `--performance` for warmed worker/provider timings and retention measurements, or `--workflow` for native dialogs, image selection, reader controls and offline exports. The workflow uses VS Code's built-in simple file picker and custom modal dialogs; its separate test harness activates normally because Extension Host test mode refuses modal dialogs. The product remains installed from the unmodified VSIX. Renderer DNS and HTTP proxy requests are blocked; HTML exports run in offline browser contexts. Optional `--os-offline` additionally attempts macOS outbound network isolation and fails if unavailable. The pinned desktop rejects this nested OS sandbox, so an OS-wide air-gap claim is not established; the Chromium sandbox is never disabled to bypass that failure. No global CLI or project dependencies are exposed to the installed runtime.

Performance samples use valid documents with an expression and bounded reference listings at 10 KiB, 100 KiB and 1 MiB, three warm-ups and 30 samples per size. They record native cached completion, eight documents with rapid edits, 100 open/close cycles, extension-host post-GC heap and host/server RSS. Results describe this corpus, not arbitrary large prose or chart-heavy documents. Existing language ceilings still apply.
