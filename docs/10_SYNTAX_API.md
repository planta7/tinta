# Portable syntax API

`@tinta/syntax` exports `parse`, `parseRecovering` and `enrichMarkdown`. `@tinta/types` supplies the shared integration types. The syntax package accepts explicit `markdown` or `tinta` profiles and text or UTF-8 bytes using `SourceInput`.

- `parse(input, options?)` returns `Result<ParsedSource>`. Syntax errors make the result unsuccessful. Success confirms parsing only: names, types, control domains, static option values, evaluation and validated program IR require the engine.
- `parseRecovering(input, options?)` retains recoverable error nodes and later syntax for editing. A successful result may contain error diagnostics; it must never be treated as a compilable program. Fatal encoding/resource failures return an unsuccessful result.
- `enrichMarkdown(input)` interprets the input as Markdown and returns a separate source buffer, descending-offset insertion edits, its original SHA-256 and diagnostics. It neither saves nor overwrites files. It reparses and compares Markdown meaning before returning a transformation. An unexpected difference returns `E_IMPORT_PRESERVATION` without transformed source.

`ParsedSource` retains original text/bytes, a syntax tree, original UTF-16 spans and parser-derived editor tokens. Node IDs use deterministic preorder numbering. Directive syntax retains explicit operands and options without adding semantic defaults. Raw HTML remains inert syntax data; parsing does not create DOM, run author code or load resources. Reader rendering and document CLI operations are not available yet.

The parser uses the locked micromark/mdast stack and only the individual table, task-list and double-tilde extensions. The [tokenizer patch](../patches/README.md) adds resource accounting without changing Markdown grammar. The [official corpus provenance](../third_party/commonmark/README.md) records its separate license.

From the repository root with the pinned toolchain:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:unit
pnpm test:conformance parsing
pnpm verify --suite parsing
```

The parsing aggregate includes specification checks, strict types, formatting/lint, dependency/license/architecture checks, unit/property/corpus tests, build, offline browser portability and the parse-only adapter. Semantic/import expectations remain unrun. Coverage includes all syntax implementation modules; the generated registry copy and type declarations are excluded, and the registry is compared byte-for-value with its normative source. Execution records are separate from source expectations.
