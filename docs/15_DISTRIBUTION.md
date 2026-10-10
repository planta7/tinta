# Software distribution contract

This contract describes distribution of the language implementation and local tools. It does not add document publishing, hosting, remote data, telemetry, an updater or any author execution capability. The source format remains `1.0`, the language contract `1.0-draft.3`, and the ABIs remain `tinta-ir-1`, `tinta-host-1` and `tinta-vscode-1`.

The machine-readable inputs are [release configuration](../toolchain/release.json), its [closed schema](../schemas/release-config.schema.json), and the [release manifest schema](../schemas/release-manifest.schema.json). Run `node scripts/distribution-package.mjs` after installing the frozen dependencies to rebuild and pack all targets under `build/distribution`. The command clears generated build and package output trees first. It creates local archives only; it does not upload them. Archive construction does not establish compatibility in every required environment or public availability.

## Names and destinations

All npm names below, the `@tinta` scope and proposed Marketplace identity `tinta.tinta` are proposals. Availability and ownership are unverified. The public repository owner/name is unset (`null`), rather than an invented account. Downloads would belong to releases of that repository. Changing a proposed identity requires updating the configuration, package mappings and metadata together. The CLI command and source profile remain `tinta`; ordinary Markdown remains `markdown`.

Root, Studio, VS Code and every package's **source** manifest stay private, with their existing development versions. The only npm privacy exception is a generated manifest for one of the ten allowlisted npm targets, inside a clean `build/release-staging` output tree. It may have `private: false`, explicit public npm access, the selected implementation version and exact internal dependency versions. It must not contain workspace/file/link references, install scripts, credentials or unapproved dependencies. No source-manifest mutation, recursive directory discovery or blanket architecture-check bypass is permitted. The generated VSIX extension manifest is a separate non-npm artifact; it never makes `@tinta/vscode` publishable.

## Package inventory

Every package is ESM. Portable libraries include TypeScript declarations and documented exports; resource and Node packages also include the resources required by their supported entry points. Every payload carries `LICENSE` and `THIRD_PARTY_NOTICES.txt`. External direct dependency pins are listed in the configuration; their transitive closure, integrity and licenses come from the frozen lockfile and notice inventory.

| Proposed npm name | Direct internal dependencies | Additional distribution content | Environment requirements |
| --- | --- | --- | --- |
| `@tinta/types` | None | Public DTOs and documented helper subpaths | Node and browsers |
| `@tinta/syntax` | types | Bundled patched parser graph, provenance and notices | Node and browsers |
| `@tinta/engine` | types, syntax | Runtime and chart-presentation subpaths | Node and browsers |
| `@tinta/charts` | types, engine | Approved geometry helpers | Node and browsers |
| `@tinta/reader` | types, engine, charts | Browser API, reader styles | Node import/types and browser DOM |
| `@tinta/artifacts` | types, syntax, engine, charts | Embedded reader runtime and styles | Node and browsers |
| `@tinta/local-files` | types, artifacts | Explicit Node filesystem capabilities | Native Node |
| `@tinta/cli` | types, engine, artifacts, local-files | Installed `tinta` bin and standalone Studio resource | Native Node |
| `@tinta/language-service` | types, syntax, engine | Portable analysis and query API | Node and browser workers |
| `@tinta/language-server` | types, language-service | Fixed Node IPC server and sibling worker bundles | Native Node |

The server has no advertised stdio executable or generic `index` export. Its package must expose the supported IPC launcher and fixed `.mjs` worker layout. Transport semantics remain those of the [native host contract](13_VSCODE.md).

The parser's `micromark` operation-budget patch must be carried in the distributed parser graph for both direct and mdast-mediated paths. Consumers cannot be required to inherit repository pnpm patch configuration or run postinstall patch scripts. External dependencies embedded by bundling remain part of license/provenance accounting. The syntax tarball bundles the neutral parser graph, keeps exact source and licenses for its embedded dependencies, and records their integrity and the patch digest in `parser-provenance.json`. Its JavaScript has no external micromark import; declared upstream dependencies remain available for public declarations. The packer verifies that direct and mdast-mediated paths resolve the same patched instance.

## Artifact inventory

Artifacts use the same implementation version and source commit. Configuration `dependencies` records package roots; recursive package edges and `embeddedTargets` define the complete internal closure, including resources that are not JavaScript imports.

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

The first implementation input is `0.1.0-dev.0`. All ten npm packages use that coordinated version with exact internal dependencies and explicit `next` dist-tag. Development integers increase for new intentionally distributed builds. A future stable implementation uses plain SemVer and `latest`; source-format `1.0` does not authorize stable software `1.0.0`. Build metadata and floating internal ranges are excluded. A changed version requires rebuilt, retested bytes. Moving a dist-tag for an unchanged version may reuse identical tarballs; it does not change embedded versions.

The proposed first Marketplace version is numeric `0.1.0`, in the pre-release channel. Extension versions are independent of npm versions and record the embedded implementation version. Odd minor versions designate pre-release; even minor versions designate stable extension releases. A transition needs a distinct numeric version and compatible update ordering. Marketplace does not accept SemVer prerelease suffixes in extension versions; see [Microsoft's version rules](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions).

The local `tinta-local.tinta` artifact remains `0.1.0-dev.0`. Both local and distribution builds embed the implementation version from `toolchain/release.json`; private source manifests retain their development placeholders. The new public ID is a separate installation. Users must deliberately disable or uninstall the local extension before enabling the public one to avoid two active providers. Preserve documents and manually check settings; no automatic migration is promised.

A coordinated release identifier is `tinta-{implementation}-vscode-{extension}-{extensionChannel}`. Its immutable Git tag is `tinta-v{implementation}-vscode-{extension}-{extensionChannel}`. Both identify one full target set and one commit/tree. The manifest digest distinguishes candidate bytes; tags are never moved. A subset release needs a separately specified target/configuration change, not silent omission of a failing artifact. Repeated local builds do not allocate public versions or tags.

## Runtime compatibility

The Node target is `>=24.21.0 <25`, with exact baseline tests on 24.21.0 for macOS arm64, Linux x64 and Windows x64. npm package checks include clean consumer installation, ESM imports and TypeScript resolution; Node-only APIs need native filesystem/IPC checks. Browser-capable libraries also need the three locked Playwright browser engines on macOS arm64. Browser worker support does not imply DOM availability in Node. Browser version fields in a produced manifest must contain actual engine versions, resolved from the pinned toolchain, rather than the configuration's `playwright-lock` selector.

VS Code Desktop requires `^1.141.0`; minimum and current tested baseline coincide at 1.141.0. The requested native matrix is macOS arm64, Linux x64 and Windows x64, with installed VSIX authoring, trusted/restricted file workflows, preview, exports, responsiveness and offline behavior. Available native observations cover macOS arm64 only. Linux/Windows native behavior and system-wide offline isolation remain unverified. No architecture may inherit another architecture's result. Remote/SSH/container workspaces, virtual filesystems and vscode.dev remain unsupported.

Reader, Studio and example artifacts require actual offline/file-origin behavior in Chromium, Firefox and WebKit from the pinned browser toolchain. The static Studio directory additionally needs relative-resource resolution. Each target's environment list is a required test matrix, not a support claim. Only observed versions and successful results for the exact archive bytes can support compatibility statements. Missing environments stay explicitly blocked or not run. No current release manifest is supplied as a claim that these checks have occurred.

## Release manifest

The manifest is a closed JSON object. Unknown properties, unsupported versions, duplicate decoded JSON keys, unsafe paths, duplicate targets and inconsistent dependency/version mappings are invalid. Consumers must bound JSON input and reject duplicate keys before materializing objects; the exported local validator accepts already materialized objects and does not implement an untrusted JSON ingestion boundary.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Release metadata format 1, independent of source/IR versions |
| `releaseId`, `tag` | Coordinated identity derived from version inputs |
| `source` | Full Git commit and tree object IDs using the same hash algorithm; SHA-256 of exact lockfile and configuration bytes |
| `versions` | Implementation/npm channel, extension/channel, contract, source-format and all three ABI identifiers |
| `targets` | Complete inventory with public name, kind, version/channel, exact internal dependency edges, external direct pins, embedded targets, archive path/bytes/SHA-256/SHA-512 SRI, license-file paths/hashes and required environments |
| `toolchain` | Exact tool versions and integrity identifiers, including Node, pnpm, TypeScript, esbuild and Playwright; additional bundled tools retained |
| `verification` | Provider, run ID, positive attempt number, exact OS version, architecture, runtime version/integrity and per-target/environment result plus hashed report |
| `limitations` | Disclosed technical limits; never a substitute for missing results |

Archive/report paths are normalized relative POSIX paths with no dot segments, backslashes, absolute paths or URL schemes. License paths are relative to each archive's payload root. SHA-512 SRI covers the complete archive bytes, not its unpacked tree. Toolchain integrity identifies an upstream distribution checksum or lock integrity; tool versions alone are insufficient provenance. Reports identify the checked archive hash and commands; a non-passing report remains representable without becoming a successful release claim.

The manifest's own digest is stored separately as `release-manifest.json.sha256`, computed over exact UTF-8 manifest bytes, including the final newline. Never put that digest, or the digest of a containing archive, inside the manifest. Verification reports hash payloads and precede the final manifest; they must not contain the final manifest hash. This avoids circular hashes. A future consumer must recompute file sizes/hashes, inspect archive entries/licenses, bind Git commit/tree and toolchain identities, and check actual reports. Schema and metadata agreement alone do not authenticate files or establish compatibility.

Run `node scripts/release-contract.mjs` for the local configuration/source dependency check, and `pnpm exec vitest run tests/unit/release-contract.test.mjs` for schema and metadata regressions. These commands do not pack, upload, register identities or alter services. They use existing pinned Ajv, SemVer and Vitest; no additional release tooling is required.


## Local package construction

The implementation version is generated into `@tinta/types/version` after TypeScript compilation and before runtime bundling. The CLI, artifact writer, embedded reader, Studio and extension build identity consume that input. Interactive envelopes retain an exact implementation-version equality check. Source-format and protocol identifiers are independent of implementation versions.

The npm staging manifests provide ESM exports and declarations, an exact internal dependency graph and Node engine constraints. `@tinta/reader/reader.css` exposes the required reader stylesheet. The CLI carries its bin launcher and standalone Studio resource. The language-server package exposes only `@tinta/language-server/ipc`: resolve this path and launch it with Node `fork` and an IPC channel. Preserve the sibling `dist/worker.mjs`. It uses UTF-16 positions and full document synchronization; there is no stdio executable or root import.

`toolchain/distribution-source.json` is the exact source-file allowlist. Packaging rejects missing, additional or symbolic-link source entries, and source bytes must remain unchanged throughout the build. Content inspections reject private paths, credentials and source maps. The narrow source-test exceptions in `toolchain/distribution-source-exceptions.json` are exact line digests for deliberately hostile fixtures and detector expressions; they do not exempt whole source files. Every npm and download payload carries its own license and third-party notices.

ZIP entries have fixed timestamps and sorted names. npm archives use the pinned pnpm packer without lifecycle scripts in generated manifests. `inventory.json` records every archive size, SHA-256, SHA-512 integrity, unpacked file hash, complete frozen external dependency closure and source dirty state. It is a local content inventory, not a release attestation or installed-consumer test result. The configured repository is currently unset, so generated package metadata omits the repository field rather than inventing one.

After constructing the archives, run `pnpm exec vitest run --config scripts/distribution-vitest.config.js` for packaging, corruption, parser-budget and IPC regressions. Installed consumer routes and platform compatibility require separate tests of the exact archives. Rebuilding under another implementation version produces a different payload and requires those tests again.
