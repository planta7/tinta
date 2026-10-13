# Contributing

Read the [scope decisions](DECISIONS.md), [language specification](spec/00_OVERVIEW.md), [architecture](architecture/MODULES.md), and [compatibility rules](docs/08_CHANGE_CONTROL.md) before changing a contract.

Install the pinned tools and dependencies using [toolchain setup](docs/09_FOUNDATION_TOOLCHAIN.md). Choose the tests for the area you change using [testing and performance](docs/07_VERIFICATION.md); `pnpm verify --suite editing` checks the document tools and Studio. See [package boundaries](architecture/MODULES.md) for the implementation structure and API references. Browser and filesystem behavior can differ across operating systems, so run the relevant platform tests for changes to those features.

## Check a change

Use Python 3.9 or newer. From the repository root:

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_contracts.py
```

The last command additionally requires an available `tsc` and Python `jsonschema`; missing prerequisites return nonzero. See [checks](scripts/README.md) for reporting and limitations. The specification checker also runs by absolute path from another working directory. No Git metadata or local progress records are required.

Keep specifications, registry, schemas, type contracts, examples and expected outcomes aligned. Preserve source spans, malformed-input coverage, security and accessibility requirements. Preserve expected outcomes and substantive assertions. Test reports are separate outputs; fixture definitions do not contain execution status.

For a normative conflict, propose a decision record under `decisions/` with the affected clauses, minimal example, test IDs, proposed resolution, and compatibility/security impact. Do not silently choose a different behavior. Preserve stable decision and test IDs.

Use US English for authored prose. Use **tinta** for the language and CLI, **tinta studio** for the full editor name and **Studio** as its short form. Keep existing package names, format identifiers, command labels and third-party wording unchanged. Keep core parsing and evaluation portable and deterministic; preserve the documented capability boundaries. Changes to dependencies follow the [stack policy](architecture/STACK.md). New features must fit the approved local document scope.

Preserve MIT copyright and third-party notices. Review file and archive contents before distribution; exclude local configuration, credentials and development outputs. Consistency checks do not establish runtime behavior or authorize publication.
