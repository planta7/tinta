# Contributing

Read the [scope decisions](DECISIONS.md), [language specification](spec/00_OVERVIEW.md), [architecture](architecture/MODULES.md), and the relevant [roadmap milestone](docs/ROADMAP.md) before changing a contract.

The repository contains specifications, declarations, fixtures, Python consistency checkers and a foundation workspace. The types and syntax packages implement portable parsing and explicit Markdown enrichment; see [syntax API](docs/10_SYNTAX_API.md). The engine implements binding, typed evaluation, transactional sessions, validated IR and pure import candidates; see [engine API](docs/11_ENGINE_API.md). The safe document reader implements DOM projection, native controls and lifecycle; see [reader API](docs/12_READER_API.md). The document CLI and editor remain unimplemented. See [foundation toolchain](docs/09_FOUNDATION_TOOLCHAIN.md) for exact installation and infrastructure checks. Document operations are not yet available.

## Check a change

Use Python 3.9 or newer. From the repository root:

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_contracts.py
```

The last command additionally requires an available `tsc` and Python `jsonschema`; missing prerequisites return nonzero. See [checks](scripts/README.md) for reporting and limitations. The specification checker also runs by absolute path from another working directory. No Git metadata or local progress records are required.

Keep specifications, registry, schemas, type contracts, examples and expected outcomes aligned. Preserve source spans, malformed-input coverage, security and accessibility requirements. Do not weaken tests or change NOT_RUN expectations into execution results. Record actual command results separately.

For a normative conflict, propose a decision record under `decisions/` with the affected clauses, minimal example, test IDs, proposed resolution, and compatibility/security impact. Do not silently choose a different behaviour. Preserve stable decision and test IDs.

Use English for project material. Keep core parsing and evaluation portable and deterministic; preserve the documented capability boundaries. Changes to dependencies follow the [stack policy](architecture/STACK.md). New features must fit the approved local document scope.

Preserve MIT copyright and third-party notices. Review file and archive contents before distribution; exclude local configuration, credentials and development outputs. Publishing and release qualification are separate from passing consistency checks.
