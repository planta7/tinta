# Contributing

Read the [scope decisions](DECISIONS.md), [language specification](spec/00_OVERVIEW.md), [architecture](architecture/MODULES.md), and [compatibility rules](docs/08_CHANGE_CONTROL.md) before changing a contract.

The repository contains specifications, declarations, fixtures, Python consistency checkers and a TypeScript workspace. The types and syntax packages implement portable parsing and explicit Markdown enrichment; see [syntax API](docs/10_SYNTAX_API.md). The engine implements binding, typed evaluation, transactional sessions, validated IR and pure import candidates; see [engine API](docs/11_ENGINE_API.md). The safe document reader implements DOM projection, native controls, seven interactive chart types and lifecycle; see [reader API](docs/12_READER_API.md). The artifact package and local CLI implement source bundles, snapshots, strict local raster resources, imports and standalone HTML exports. The reference editor implements local document editing and standalone Studio packaging; see the [editor contract](docs/03_EDITOR_AND_READER.md). See [foundation toolchain](docs/09_FOUNDATION_TOOLCHAIN.md) for exact installation and infrastructure checks. Use `pnpm verify --suite editing` to check the document tooling and editor. Browser and filesystem behavior can differ across operating systems; choose the corresponding tests for the change.

## Check a change

Use Python 3.9 or newer. From the repository root:

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_contracts.py
```

The last command additionally requires an available `tsc` and Python `jsonschema`; missing prerequisites return nonzero. See [checks](scripts/README.md) for reporting and limitations. The specification checker also runs by absolute path from another working directory. No Git metadata or local progress records are required.

Keep specifications, registry, schemas, type contracts, examples and expected outcomes aligned. Preserve source spans, malformed-input coverage, security and accessibility requirements. Preserve expected outcomes and substantive assertions. Test reports are separate outputs; fixture definitions do not contain execution status.

For a normative conflict, propose a decision record under `decisions/` with the affected clauses, minimal example, test IDs, proposed resolution, and compatibility/security impact. Do not silently choose a different behaviour. Preserve stable decision and test IDs.

Use English for project material. Keep core parsing and evaluation portable and deterministic; preserve the documented capability boundaries. Changes to dependencies follow the [stack policy](architecture/STACK.md). New features must fit the approved local document scope.

Preserve MIT copyright and third-party notices. Review file and archive contents before distribution; exclude local configuration, credentials and development outputs. Consistency checks do not establish runtime behavior or authorize publication.
