# Software distribution contract

This contract describes distribution of the language implementation and local tools. It does not add document publishing, hosting, remote data, telemetry, an updater or any author execution capability. The source format remains `1.0`, the language contract `1.0-draft.3`, and the ABIs remain `tinta-ir-1`, `tinta-host-1` and `tinta-vscode-1`.

The machine-readable inputs are [release configuration](../toolchain/release.json), its [closed schema](../schemas/release-config.schema.json), and the [release manifest schema](../schemas/release-manifest.schema.json). Run `node scripts/distribution-package.mjs` after installing the frozen dependencies to rebuild and pack all targets under `build/distribution`. The command clears generated build and package output trees first. It creates local archives only; it does not upload them. Archive construction does not establish compatibility in every required environment or public availability.

## Names and destinations

The npm packages use the `@tinta-lang` scope. Source and downloads belong to `planta7/tinta` on GitHub, and the Marketplace extension ID is `planta7.tinta`. The CLI command and source profile remain `tinta`; ordinary Markdown remains `markdown`. Package and extension availability is independent of these configured identities.

Root, Studio, VS Code and every package's **source** manifest stay private, with their existing development versions. The only npm privacy exception is a generated manifest for one of the ten allowlisted npm targets, inside a clean `build/release-staging` output tree. It may have `private: false`, explicit public npm access, the selected delivery version and exact internal dependency versions. It must not contain workspace/file/link references, install scripts, credentials or unapproved dependencies. No source-manifest mutation, recursive directory discovery or blanket architecture-check bypass is permitted. The generated VSIX extension manifest is a separate non-npm artifact; it never makes `@tinta-lang/vscode` publishable.

## Package inventory

Every package is ESM. Portable libraries include TypeScript declarations and documented exports; resource and Node packages also include the resources required by their supported entry points. Every payload carries `LICENSE` and `THIRD_PARTY_NOTICES.txt`. External direct dependency pins are listed in the configuration; their transitive closure, integrity and licenses come from the frozen lockfile and notice inventory.

| npm name | Direct internal dependencies | Additional distribution content | Environment requirements |
| --- | --- | --- | --- |
| `@tinta-lang/types` | None | Public DTOs and documented helper subpaths | Node and browsers |
| `@tinta-lang/syntax` | types | Bundled patched parser graph, provenance and notices | Node and browsers |
| `@tinta-lang/engine` | types, syntax | Runtime and chart-presentation subpaths | Node and browsers |
| `@tinta-lang/charts` | types, engine | Approved geometry helpers | Node and browsers |
| `@tinta-lang/reader` | types, engine, charts | Browser API, reader styles | Node import/types and browser DOM |
| `@tinta-lang/artifacts` | types, syntax, engine, charts | Embedded reader runtime and styles | Node and browsers |
| `@tinta-lang/local-files` | types, artifacts | Explicit Node filesystem capabilities | Native Node |
| `@tinta-lang/cli` | types, engine, artifacts, local-files | Installed `tinta` bin and standalone Studio resource | Native Node |
| `@tinta-lang/language-service` | types, syntax, engine | Portable analysis and query API | Node and browser workers |
| `@tinta-lang/language-server` | types, language-service | Fixed Node IPC server and sibling worker bundles | Native Node |

The server has no advertised stdio executable or generic `index` export. Its package must expose the supported IPC launcher and fixed `.mjs` worker layout. Transport semantics remain those of the [native host contract](13_VSCODE.md).

The parser's `micromark` operation-budget patch must be carried in the distributed parser graph for both direct and mdast-mediated paths. Consumers cannot be required to inherit repository pnpm patch configuration or run postinstall patch scripts. External dependencies embedded by bundling remain part of license/provenance accounting. The syntax tarball bundles the neutral parser graph, keeps exact source and licenses for its embedded dependencies, and records their integrity and the patch digest in `parser-provenance.json`. Its JavaScript has no external micromark import; declared upstream dependencies remain available for public declarations. The packer verifies that direct and mdast-mediated paths resolve the same patched instance.

## Artifact inventory

Artifacts record their language implementation version and source commit. Studio downloads use the Studio delivery version; the VSIX uses the extension version; reader and example downloads use the language implementation version. Configuration `dependencies` records package roots; recursive package edges and `embeddedTargets` define the complete internal closure, including resources that are not JavaScript imports.

| Target | Container and required content | Dependency roots |
| --- | --- | --- |
| `vscode` | VSIX with extension metadata, native host, IPC server, analysis/artifact workers, preview, grammar/catalog, README and notices | types, local-files, artifacts, engine, reader, language-service, language-server |
| `studio-directory` | ZIP containing static `index.html`, relative application chunks, compiler/preview resources and notices | types, syntax, engine, charts, reader, artifacts |
| `studio-standalone` | ZIP containing `tinta-studio.html` and notices | Same as Studio directory |
| `reader-runtime` | ZIP containing `reader.js`, `reader.css` and notices | types, engine, charts; entry from reader |
| `source` | ZIP with an explicit public tracked-file inventory, source, schemas, specifications, contracts, lockfile, patches and notices | No installed dependency; complete source inventory |
| `examples` | ZIP with `.tinta` examples, local raster images, `.tinta.zip` bundles, interactive/static HTML and notices | artifacts and its reader closure |

A `.tinta.zip` inside the examples archive retains its existing source-bundle format; distribution ZIPs are not source bundles. Standalone files retain their canonical names inside archives. The static Studio directory is a download, with no hosting service implied. Source archives exclude local instructions, plans, execution records, credentials, dependency installations and incidental build outputs. Every archive must have an explicit entry allowlist; a Git tree identity alone does not authorize every tracked file. Public source manifests in the source archive retain `private: true`.

## Versions and channels

The first implementation input is `0.1.0-dev.0`. The initial ten npm packages used that coordinated version with exact internal dependencies and explicit `next` dist-tag. The nine language libraries continue to share an implementation version. The CLI now shares the independent Studio delivery version, while its internal dependencies remain pinned exactly to the language implementation version. Development integers increase for new intentionally distributed builds. The initial `0.1.0-dev.0` also retains the registry-created `latest` tag, so an unversioned npm install selects this prerelease until a stable release replaces that tag. A future stable implementation uses plain SemVer and `latest`; source-format `1.0` does not authorize stable software `1.0.0`. Build metadata and floating internal ranges are excluded. A changed version requires rebuilt, retested bytes. Moving a dist-tag for an unchanged version may reuse identical tarballs; it does not change embedded versions.

The first Marketplace version is numeric `0.1.0`, in the pre-release channel. Extension versions are independent of npm versions and record the embedded implementation version. Odd minor versions designate pre-release; even minor versions designate stable extension releases. A transition needs a distinct numeric version and compatible update ordering. Marketplace does not accept SemVer prerelease suffixes in extension versions; see [Microsoft's version rules](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions).

The local `tinta-local.tinta` artifact remains `0.1.0-dev.0`. Both local and distribution builds embed the implementation version from `toolchain/release.json`; private source manifests retain their development placeholders. The new public ID is a separate installation. Users must deliberately disable or uninstall the local extension before enabling the public one to avoid two active providers. Preserve documents and manually check settings; no automatic migration is promised.

A coordinated release identifier is `tinta-{implementation}-vscode-{extension}-{extensionChannel}`. Its immutable Git tag is `tinta-v{implementation}-vscode-{extension}-{extensionChannel}`. Both identify one full target set and one commit/tree. The manifest digest distinguishes candidate bytes; tags are never moved. This full-set form remains supported for local construction with coordinated implementation/CLI versions; independently versioned Studio deliveries require component metadata. Component releases use the explicit inventories below; omitting a failing target from a component is invalid. Repeated local builds do not allocate public versions or tags.

## Runtime compatibility

The Node target is `>=24.21.0 <25`, with exact baseline tests on 24.21.0 for macOS arm64, Linux arm64 and Windows x64. npm package checks include clean consumer installation, ESM imports and TypeScript resolution; Node-only APIs need native filesystem/IPC checks. Browser-capable libraries also need the three locked Playwright browser engines on macOS arm64. Browser worker support does not imply DOM availability in Node. Browser version fields in a produced manifest must contain actual engine versions, resolved from the pinned toolchain, rather than the configuration's `playwright-lock` selector.

VS Code Desktop requires `^1.141.0`; minimum and current tested baseline coincide at 1.141.0. The requested native matrix is macOS arm64, Linux arm64 and Windows x64, with installed VSIX authoring, trusted/restricted file workflows, preview, exports, responsiveness and offline behavior. Each candidate supplies its own results for those exact native targets, including OS-wide offline isolation. No architecture may inherit another architecture's result. Remote/SSH/container workspaces, virtual filesystems and vscode.dev remain unsupported.

Reader, Studio and example artifacts require actual offline/file-origin behavior in Chromium, Firefox and WebKit from the pinned browser toolchain. The static Studio directory additionally needs relative-resource resolution. Each target's environment list is a required test matrix, not a support claim. Only observed versions and successful results for the exact archive bytes can support compatibility statements. Missing environments stay explicitly blocked or not run. No current release manifest is supplied as a claim that these checks have occurred.

## Release manifest

The manifest is a closed JSON object. Unknown properties, unsupported versions, duplicate decoded JSON keys, unsafe paths, duplicate targets and inconsistent dependency/version mappings are invalid. Consumers must bound JSON input and reject duplicate keys before materializing objects; the exported local validator accepts already materialized objects and does not implement an untrusted JSON ingestion boundary.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Format 1 for the legacy complete inventory; format 2 for explicit component inventories; independent of source/IR versions |
| `releaseId`, `tag` | Full-set or component identity derived from version inputs |
| `component` | Optional `language`, `studio` or `vscode`; absence requires the complete sixteen-target inventory |
| `source` | Full Git commit and tree object IDs using the same hash algorithm; SHA-256 of exact lockfile and configuration bytes |
| `versions` | Language implementation/npm channel, optional Studio delivery version, extension/channel, contract, source-format and all three ABI identifiers |
| `targets` | Complete inventory with public name, kind, version/channel, exact internal dependency edges, external direct pins, embedded targets, archive path/bytes/SHA-256/SHA-512 SRI, license-file paths/hashes and required environments |
| `toolchain` | Exact tool versions and integrity identifiers, including Node, pnpm, TypeScript, esbuild and Playwright; additional bundled tools retained |
| `verification` | Provider, run ID, positive attempt number, exact OS version, architecture, runtime version/integrity and per-target/environment result plus hashed report |
| `limitations` | Disclosed technical limits; never a substitute for missing results |

Archive/report paths are normalized relative POSIX paths with no dot segments, backslashes, absolute paths or URL schemes. License paths are relative to each archive's payload root. SHA-512 SRI covers the complete archive bytes, not its unpacked tree. Toolchain integrity identifies an upstream distribution checksum or lock integrity; tool versions alone are insufficient provenance. Reports identify the checked archive hash and commands; a non-passing report remains representable without becoming a successful release claim.

The manifest's own digest is stored separately as `release-manifest.json.sha256`, computed over exact UTF-8 manifest bytes, including the final newline. Never put that digest, or the digest of a containing archive, inside the manifest. Verification reports hash payloads and precede the final manifest; they must not contain the final manifest hash. This avoids circular hashes. A future consumer must recompute file sizes/hashes, inspect archive entries/licenses, bind Git commit/tree and toolchain identities, and check actual reports. Schema and metadata agreement alone do not authenticate files or establish compatibility.

Run `node scripts/release-contract.mjs` for the local configuration/source dependency check, and `pnpm exec vitest run tests/unit/release-contract.test.mjs` for schema and metadata regressions. These commands do not pack, upload, register identities or alter services. They use existing pinned Ajv, SemVer and Vitest; no additional release tooling is required.


## Local package construction

The implementation version is generated into `@tinta-lang/types/version` after TypeScript compilation and before runtime bundling. The artifact writer, embedded reader, Studio document runtime and extension build identity consume that input. CLI `--version` and Studio application identity use `versions.studio`, falling back to the implementation version for local builds. A CLI delivery update never changes the implementation version embedded in documents. Interactive envelopes retain an exact implementation-version equality check. Source-format and protocol identifiers are independent of implementation versions.

The npm staging manifests provide ESM exports and declarations, an exact internal dependency graph and Node engine constraints. `@tinta-lang/reader/reader.css` exposes the required reader stylesheet. The CLI carries its bin launcher and standalone Studio resource. The language-server package exposes only `@tinta-lang/language-server/ipc`: resolve this path and launch it with Node `fork` and an IPC channel. Preserve the sibling `dist/worker.mjs`. It uses UTF-16 positions and full document synchronization; there is no stdio executable or root import.

`toolchain/distribution-source.json` is the exact source-file allowlist. Packaging rejects missing, additional or symbolic-link source entries, and source bytes must remain unchanged throughout the build. Content inspections reject private paths, credentials and source maps. The narrow source-test exceptions in `toolchain/distribution-source-exceptions.json` are exact line digests for deliberately hostile fixtures and detector expressions; they do not exempt whole source files. Every npm and download payload carries its own license and third-party notices.

ZIP entries have fixed timestamps and sorted names. npm archives use the pinned pnpm packer without lifecycle scripts in generated manifests. `inventory.json` records every archive size, SHA-256, SHA-512 integrity, unpacked file hash, complete frozen external dependency closure and source dirty state. It is a local content inventory, not a release attestation or installed-consumer test result. Generated packages include the repository configured for the release.

After constructing the archives, run `pnpm exec vitest run --config scripts/distribution-vitest.config.js` for packaging, corruption, parser-budget and IPC regressions. Installed consumer routes and platform compatibility require separate tests of the exact archives. Rebuilding under another implementation version produces a different payload and requires those tests again.

## Testing supplied archives

`node scripts/consumer-artifacts.mjs <inventory.json> <dependency-directory> <report.json>` tests supplied archives without rebuilding them. The complete declared component inventory must sit beside it, or all sixteen archives for full-set construction. Studio inventories also carry integrity-checked library tarballs under `verification/`: these are installation inputs, never publication targets or GitHub download assets. Every archive and member hash is checked before use; installed npm package files are checked again after the tests. Run with the pinned Node, npm 11.19.0, pnpm 10.34.6 and browser binaries. The harness uses the cached exact Corepack pnpm CLI, or an explicit `TINTA_CONSUMER_PNPM` path to that version's `bin/pnpm.cjs`. It records the CLI hash and rejects other versions. Automatic tool downloads are disabled. A native `tar` executable is required to read integrity-verified upstream package manifests.

Prepare dependency bytes separately with `node scripts/consumer-dependencies.mjs <inventory.json> <dependency-directory>`. It accepts existing archives or npm cache content only after matching their reviewed SHA-512 integrity. An explicit `--download` allows read-only acquisition from the fixed npm registry origin; it does not upload anything. The exact TypeScript and Node declaration tools come from the repository's reviewed lock inventory. No credentials are used.

The consumer harness loads verified tarballs into a sealed in-memory registry on an ephemeral `127.0.0.1` port. It has no upstream proxy or upload endpoint. npm and pnpm install the original dependency edges in separate temporary projects outside the checkout, with fresh caches, stores and configuration, no ambient `NODE_PATH`, and installation scripts disabled. Runtime checks require no registry requests. The test covers ESM exports, strict declaration resolution, parser budgets/recovery, evaluation, language queries, IPC/worker restart, CLI image boundaries, bundles, HTML and Studio resources. A disposable hook-removal fault demonstrates that an unpatched parser is rejected; original installed bytes are restored and rechecked.

Chromium, Firefox and WebKit exercise installed reader/chart code and standalone resources. Exported HTML and standalone Studio run at file origin in offline contexts. The Studio directory runs under a nested loopback path with nonlocal requests denied, checking relative resource lookup. These are browser-context checks, not proof of OS-wide network isolation. Temporary projects and the JSON report retain diagnostic evidence. Missing tools or browsers fail the command; a successful command covers only its recorded OS and architecture.

Use `node scripts/test-vscode-installed.mjs <desktop> <desktop-cli> <exact-vsix> <fresh-directory> --release` with each of `--workflow`, `--restricted` and `--performance` to test the same supplied distribution VSIX in isolated profiles. The installed harness also checks the bundled server's watchdog using a disposable stalled worker, then restores the production worker for recovery. `--os-offline` requests the stronger macOS isolation mode and fails if that environment cannot start. Native Linux/Windows and other architectures require independent runs; a local result cannot substitute for them.

## Automatic versions and release notes

Use [Conventional Commits](../CONTRIBUTING.md#commit-messages-and-versions) to describe each change. Versions are calculated independently from the changes since each component's latest reachable release tag. The highest relevant impact determines that component's next version; commit scopes describe changes but do not select components.

| Commit | Version change |
| --- | --- |
| `fix`, `perf`, `revert` | Patch |
| `feat` | Minor |
| `!`, `BREAKING CHANGE:`, `BREAKING-CHANGE:` | Major, or minor while the major version is zero |
| Other types without an incompatible change | No release |

Use lowercase Conventional Commit types. The standard preset ignores unrecognized messages and cancels matching reverted changes; there is no custom commit-message validator. Minor and major changes reset the patch to zero. Stable extension minor versions advance by two to keep even minor numbers. For example, a language feature after libraries `0.1.21` and extension `0.2.21` selects libraries `0.2.0` and extension `0.4.0`. A Studio-only feature advances Studio/CLI independently and leaves both those versions unchanged. Moving to `1.0.0` is a separate compatibility decision. Software versions do not change the source-format or protocol versions.

Release notes list the changes touching the component since its own latest reachable tag, including changes merged from branches. A tag for another component does not truncate that history. Failed releases can leave gaps in the version sequence; a version is never reused for different source.

## Component selection

[The component catalog](../toolchain/components.json) assigns each target to exactly one of three delivery groups. Every component also includes a source ZIP and a closed release manifest. Each manifest requires that group's complete target inventory and every required environment for those targets. The absence of `component` retains the original full-set format 1 contract. Component manifests use metadata format 2 so older closed-schema consumers reject them explicitly rather than mistaking them for an incomplete format 1 release. This changes only distribution metadata, not source, IR, host or webview formats.

| Component | Inputs and dependent consumers | Checks and outputs | Version and immutable tag |
| --- | --- | --- | --- |
| `language` | Shared libraries, language/runtime resources and shared configuration. A language version change also changes both hosts' exact dependencies or embedded implementation. | Nine npm libraries, reader runtime and examples; npm/pnpm installations on all three native platforms, three browser engines, parser and IPC regressions. Both host groups are rebuilt and verified when the language changes. | Coordinated language SemVer; `tinta-language-v{version}` |
| `studio` | Studio editor/application and CLI, which embeds the standalone Studio. | CLI tarball and both Studio ZIPs; CLI portability, Studio coverage/size and browser tests, installed CLI/resources and both npm/pnpm routes on all three native platforms. Publishes only CLI, Studio downloads and the Pages demo. | Independent Studio/CLI SemVer; `tinta-studio-v{version}` |
| `vscode` | Native extension and shared preview inputs. | VSIX, extension unit/browser tests and the same installed trusted/restricted/performance/OS-offline checks on all three native platforms. Publishes only the VSIX and extension downloads. | Independent numeric version with stable even minor; `tinta-vscode-v{version}` |

Git attributes in [`.gitattributes`](../.gitattributes) are the single path map for source verification and release history. Studio's `preview.ts`, `protocol.ts`, preview styles and preview TypeScript configuration also affect VS Code. Examples affect language downloads and Studio. Prose-only changes use metadata checks; normative contracts/specifications and packaged library README files remain shared inputs. Application README files retain their component ownership. Unclassified and shared files conservatively affect every component. Git treats cross-component renames as deletion plus addition for impact selection. The preview build regression checks its actual Studio module inputs against the shared ownership map.

Source verification compares the pull request base or push predecessor with the checked source. On pushes to `main`, it also verifies every component selected by cumulative release planning, including dependent hosts. This repeats the applicable source checks for pending releases after an earlier verification failed or was cancelled, even when the latest push changes only documentation. Release planning examines the cumulative history since each component's own reachable tag; it does not use only the last push. The initial baseline for each group is the latest reachable legacy coordinated stable tag. No migration commit, reservation branch or seeded public tag is needed.

Library versions remain coarse by design: splitting the exact internal library graph into nine independent release processes would require additional dependency/version coordination. Thus a language-group update also rebuilds the hosts. If any releasable change depends on unreleased language-group changes, even changes whose commit type alone requests no release, the language and both hosts advance at least a patch. This prevents embedding new implementation bytes under an old public version. Studio-only changes with an unchanged language group do not advance library or extension versions. A change in the shared preview advances Studio and the extension, without releasing the libraries.

Source manifests remain private placeholders. Release-it receives generated private version inputs, the component's tag baseline and the native Git attribute pathspec. No version-only source commits are needed. Builds read the source-bound generated plan. CLI/Studio tarballs use their delivery version and pin dependencies to the selected language version, for example CLI `0.7.3` can depend exactly on language `0.1.21`. Document envelopes still use `0.1.21`, matching their embedded reader.

When language packages are part of the same release, Studio's installation tests consume those exact new tarballs. Otherwise `npm pack` acquires the exact already-published dependency versions from the fixed npm registry, with scripts disabled; their names, versions, bytes and integrity are recorded in `inventory.json`. Dependency acquisition occurs before the sealed consumer registry starts. These verification inputs are excluded from npm publication and GitHub download assets. Public dependency availability is required; a missing dependency after a partial earlier release fails the build and requires recovery of that earlier release.

For local component construction, run `pnpm build:language`, `pnpm build:studio` or `pnpm build:vscode`, followed by `TINTA_COMPONENT=<component> node scripts/distribution-package.mjs --built`. The environment variable also selects the applicable archive tests/checker and supplied-archive consumer route. Without it the full construction/test commands retain all sixteen targets. On shells without inline environment assignment, set `TINTA_COMPONENT` using the shell's native syntax first.

## Publish a release

1. Make the change on a working branch and use a Conventional Commit with a descriptive scope.
2. Wait for `Verify language` to pass, review the change, and merge it into `main`.
3. Verification runs on `main`. `Publish release` calculates each component's cumulative changes and publishes only the selected groups.
4. Check the [workflow results](https://github.com/planta7/tinta/actions) and [release downloads](https://github.com/planta7/tinta/releases).

No manual version edit or version-only commit is required. Documentation and test commits alone do not request a release unless they declare an incompatible change. Unreleased changes are nevertheless included when the next applicable release occurs.

`Verify language` keeps the protected `verify`, `cli-portability (macos-15)` and `cli-portability (windows-2022)` contexts. Shared changes run the complete source suite. Studio-only and extension-only changes use their applicable build/test commands, while format, lint, dependency/license, architecture, specification and component-selection checks still run. The CLI jobs explicitly report not applicable when Studio/CLI inputs are unchanged; that report is not an executed portability test.

`Publish release` accepts only a successful same-repository push verification for `main` whose source SHA also matches the workflow revision. A superseded verification is skipped; a later verified revision includes its unreleased changes. The serialized workflow builds selected groups once into one immutable payload artifact. The installed matrix crosses only those groups with the three required native platforms. Every release job validates all three reports for its own component against the producer, source, exact inventory and archive hashes; another component's failed report cannot substitute for its results. No missing or failed component report authorizes a write.

Language packages are published before their dependent hosts. Studio and VS Code then run in separate matrix jobs with `fail-fast: false`, so an unrelated host failure does not prevent the other's completed release. Native YAML aliases share the destination steps. There are no additional workflow files, action dependencies, coordination store or destination SDK clients. Publication retains the existing `publish-release.yml` and `release` environment trusted-publisher binding. Destination credentials are used only after archive/report verification; Azure login runs only for the extension job.

A component's Git tag fixes its source and version before the draft GitHub release and destination upload. It is never moved and remains the next version baseline even if an upload fails. Each npm package is published directly to `latest`; Marketplace receives the tested VSIX. The component's GitHub release becomes public only after that component's destination uploads succeed. There is no cross-service transaction. The Pages job independently requires a completed Studio release and deploys only the highest completed Studio version, checking the downloaded ZIP against the tested immutable inventory and rechecking freshness before deployment. It does not deploy extension-only releases.

If a job fails, use **Re-run failed jobs** after resolving its cause. Successful build jobs retain their original artifact ID and versions; native reports are keyed to component, platform and that payload ID. Only successful installed jobs upload release receipts, so a failed scope can be rerun without colliding with a prior failed receipt. Do not rerun all jobs after a version has been allocated. Artifacts expire after 30 days; expired inputs require investigation rather than reconstruction under an existing version.

A collision or lost upload response fails the job. Before retrying a write, inspect the destination's version, source tag and archive digest against the retained inventory. An identical existing upload requires explicit manual recovery; the workflow does not infer success or overwrite it. A partially created draft release must be completed manually from retained verified assets, without `--clobber`. Rerunning its creation rejects the existing release. Complete remaining destinations manually after inspection, or use a new verified source revision. Leave allocated tags and versions intact; deleting a version, moving a tag or rebuilding different bytes under it is unsupported. Historical reservation/publication branches remain historical data and are never read or updated.
