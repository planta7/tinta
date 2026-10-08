# Tinta

Tinta is a Markdown-first language for interactive documents: prose enriched with controls, calculations, conditional explanations, tables, and seven interactive chart types.

```tinta
@let price = 19
@slider people = 5 (min: 1, max: 40, label: "People")

# Explore the cost

For **{{ people }} people**, the monthly amount is **{{ money(people * price) }}**.

@when people >= 20
A larger team may need a different arrangement.
@end
```

Source is UTF-8 `.tinta`; `.tinta.zip` bundles source and local images. Existing `.md` files retain Markdown behaviour until explicitly enriched into a separate document.

Tinta is local-only. The planned engine, CLI, reader, reference editor and HTML exports have no accounts, hosting, sync, telemetry, remote data or AI features. It is a document language, not an application or website framework.

## Status

Contract revision **1.0-draft.2** is a draft specification with type declarations, schemas and fixtures. The parser, engine, reader, editor and CLI are not implemented. The 98 semantic cases and 46 scenarios define expected outcomes; they have not been executed against a runtime.

## Explore

- [Language overview](spec/00_OVERVIEW.md) and [cheatsheet](docs/CHEATSHEET.md)
- [Examples](examples/README.md) and [file formats](docs/02_FILES_AND_EXPORTS.md)
- [Product scope](docs/01_PRODUCT.md) and [decisions](DECISIONS.md)
- [Architecture](architecture/MODULES.md) and [stack](architecture/STACK.md)
- [Contracts](contracts/CONTRACT_RULES.md) and [conformance](conformance/README.md)
- [Roadmap](docs/ROADMAP.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md)

The foundation workspace and locked toolchain are described in [foundation tooling](docs/09_FOUNDATION_TOOLCHAIN.md). Empty package scaffolds do not implement the language.

## Available checks

```sh
python3 scripts/check_spec.py
python3 -m unittest discover -s scripts/tests -v
```

These use Python's standard library. Optional type/schema checks require TypeScript and Python `jsonschema`; see [checker prerequisites and limits](scripts/README.md). They do not establish language conformance.

## License

[MIT](LICENSE). Third-party material retains its own notices and licenses. `@tinta/*` names are internal workspace identifiers; no public namespace ownership is claimed.
