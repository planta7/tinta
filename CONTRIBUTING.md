# Contributing

Read the [product scope](docs/01_PRODUCT.md), [language specification](spec/00_OVERVIEW.md), [architecture](architecture/MODULES.md), and [compatibility rules](docs/08_CHANGE_CONTROL.md) before changing a contract.

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

For a normative conflict, describe the affected clauses, minimal example, test IDs, proposed resolution, and compatibility/security impact in the issue or pull request. Resolve the conflict in the relevant specification or technical reference before implementing the affected behavior. Preserve stable requirement and test IDs.

Use US English for authored prose. Use **tinta** for the language and CLI, **tinta studio** for the full editor name and **Studio** as its short form. Keep existing package names, format identifiers, command labels and third-party wording unchanged. Keep core parsing and evaluation portable and deterministic; preserve the documented capability boundaries. Changes to dependencies follow the [stack policy](architecture/STACK.md). New features must fit the documented local document scope.

Preserve MIT copyright and third-party notices. Review file and archive contents before distribution; exclude local configuration, credentials and development outputs. Consistency checks validate document and schema structure; runtime behavior requires the relevant tests.

## Commit messages and versions

Use Conventional Commits with a descriptive scope, such as `fix(parser): recover malformed input` or `feat(cli): add a command`. A `fix`, `perf` or `revert` requests a patch; a `feat` requests a minor. Mark incompatible changes with `!` before the colon or a `BREAKING CHANGE:` footer. Other commit types do not request publication unless they declare an incompatible change. Describe the actual compatibility impact rather than choosing a message to obtain a particular number.

Verification runs on pull requests targeting `main` and pushes to `main`. Pull requests do not publish; a successful push verification on `main` can trigger publication when the changes request a release. Use lowercase Conventional Commit types: the standard preset ignores unrecognized messages and cancels matching reverted changes; there is no custom commit-message validator.

The highest impact among product changes to a component since its latest reachable release tag selects that component's next version. CI infrastructure and tests still select verification but do not request product versions, even when their commit message uses `fix` or `feat`. Build, packaging and dependency inputs remain product changes. That tag remains its version baseline even if a later publication step fails. During `0.x` development, incompatible changes advance the minor, and the transition to `1.0.0` is explicit. The extension keeps its independent stable-channel numbering. See [distribution](docs/15_DISTRIBUTION.md#automatic-versions-and-release-notes) for version and channel rules.

Component CI/CD selection uses native Git attributes from `.gitattributes`. Keep shared preview inputs assigned to both Studio and VS Code. The language libraries form one version group; Studio/CLI and the extension have independent delivery versions and tags. See [the distribution contract](docs/15_DISTRIBUTION.md#component-selection) for selection, dependency pins, installed-consumer checks and recovery. Commit scopes do not determine affected components.
