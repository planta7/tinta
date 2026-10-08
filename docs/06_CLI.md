# CLI contract

The command name is the internal executable `tinta`; no public npm-name availability or package publication is assumed. In a development workspace use `pnpm --filter @tinta/cli exec tinta ...` after building/linking the workspace. `--help` and `--version` are implemented before other commands. Version prints implementation semver, source-format version and IR ABI.

## Commands

```text
tinta check INPUT [--profile markdown|tinta] [--with-assets] [--asset-root DIR] [--json] [--warnings-as-errors]
tinta enrich INPUT.md --output OUTPUT.tinta [--force] [--json]
tinta build INPUT --format interactive|static --output OUTPUT.html [--profile markdown|tinta]
         [--state initial|snapshot] [--snapshot FILE.tinta.state.json] [--asset-root DIR] [--force] [--json]
tinta pack INPUT.tinta --output OUTPUT.tinta.zip [--asset-root DIR] [--force] [--json]
tinta unpack INPUT.tinta.zip --output-dir NEW_DIRECTORY [--json]
tinta import-data INPUT.csv|INPUT.json --name IDENTIFIER --output OUTPUT.tinta [--schema SCHEMA.json] [--force] [--json]
tinta studio [--output OUTPUT.html] [--force] [--json]
```

No abbreviation, unlisted alias, implicit command, unknown flag or duplicate scalar flag is accepted. Flag values may follow `=` or be a separate token. `--` ends flags; a following path is an operand, even if it begins with `-`. Paths may contain spaces/Unicode and are passed as argument strings, never concatenated into a shell command. There are no environment variables that change language semantics, locale, state or asset permissions. `NO_COLOR` may disable terminal colouring only; JSON output never has ANSI colours.

## Inputs and profiles

INPUT may be a `.md`, `.tinta` or `.tinta.zip` path for check/build. `.md` selects markdown; `.tinta` and source from a bundle select tinta. An explicit profile overrides the suffix. A bundle cannot be overridden to markdown because its manifest declares Tinta source; such an override is a usage error. An unknown suffix requires --profile. `-` means stdin for check/build/enrich only; check/build stdin requires explicit --profile. Relative assets from stdin require --asset-root; do not assume the process working directory grants source access. File/ZIP inputs are bounded before use.

`check` validates parsing, names, types, cycles, source defaults and visible initial figures. It does not resolve image files unless --with-assets. With assets it validates all images, including hidden branches, for interactive portability. Without assets it reports `assetsChecked:false`, never implies a complete portable artifact. --asset-root without --with-assets is a usage error for check. --warnings-as-errors changes the exit status but not warning severity/code.

`enrich` always processes the input as Markdown, produces collision-aware new Tinta source and preserves the input. It does not fetch images or silently inline them. It returns the proposed edits and safe-profile warnings through --json. No --profile option for this command. A `.tinta` or source bundle input to enrich is a usage error; use raw Markdown or stdin.

`build` requires --format and --output. Default state is initial. --state snapshot requires --snapshot; providing --snapshot without --state snapshot is a usage error. Validate snapshot source hash and every control before output. Markdown profile permits initial only because it contains no reader controls. An interactive bundle build reads and verifies its own resources; --asset-root with a bundle is a usage error. Static resource/visibility rules are in the export contract. Output contains no build timestamp or absolute input path.

`pack` reads valid Tinta source, resolves all image resources inside the input directory or explicit root, canonicalizes a copy and writes the specified bundle. It does not change the input source. `unpack` validates the entire bundle, then stages the complete extracted tree into a new directory. That target must not already exist; there is no force option for directory replacement. On failure, remove the new staging area only, not user paths.

`import-data` accepts CSV or JSON as specified in the data contract and writes a standalone valid Tinta file containing one @data declaration. --name must be a valid, nonreserved identifier. Default column mapping/type inference is deterministic. Optional --schema is the `tinta-import-schema` envelope with an ordered entry for every original column (`input`, `name`, `type`); no missing/extra columns or silent coercion. JSON shape is in `schemas/import.schema.json`. For source JSON, explicit type changes only allow the existing type or text conversion of a scalar using canonical true/false/number strings; nested/null values remain rejected. CSV numeric/boolean conversions follow the data rules. Original imported files are never modified.

`studio` without output prints the absolute file URI of the installed standalone editor; it does not start a server or launch a shell/browser. With --output it copies that bundled standalone HTML to the selected file. A missing production build is an explicit IO/build installation error, not a remote fallback. The command never hosts/uploads a document.

## Output, errors and exit codes

Successful file-producing commands send one concise artifact summary to stdout; diagnostics go to stderr. --json emits exactly one UTF-8 JSON envelope to stdout and no human diagnostics there: `{ok, command, artifacts, diagnostics, details}`. Artifact records have path, bytes, sha256 and mediaType. Exit status remains meaningful in JSON mode. Human stderr may include the requested source URI and escaped short context; it never dumps the whole source/asset. JSON details include assetsChecked, profile, source version and selected state where relevant.

Exit codes: 0 success; 1 document/schema/state/assets validation failure; 2 usage/unknown argument; 3 authorized IO or output-conflict failure; 4 unexpected internal failure. Warnings alone yield 0 except check --warnings-as-errors, which yields 1. SIGINT is 130, discards a staged output and preserves existing files. Runtime budget/worker limit violations are validation failure 1 unless caused by an internal engine fault. No partial HTML or error message is written into the requested artifact path.

## Writes

Resolve and validate input/output identities before reading/writing. Never allow output to be the same file as input, including symlink/realpath aliases. Existing output requires --force, but --force does not bypass source validity, path safety, read-only permissions, input identity or resource limits. Use same-directory temporary files and the atomicity procedure in the artifact contract. A successful JSON response is emitted only after the final file is committed and hashed. STDOUT is never used as a binary artifact stream in V1.

The source root and output directory are separate grants: an explicit output path permits writing that artifact only, not reading arbitrary files from that directory. No glob expansion, automatic recursive directory processing or hidden watch service exists. Check/build do not scan sibling documents or submit anything to a service.
