# Software distribution contract

This contract describes distribution of the language implementation and local tools. It does not add document publishing, hosting, remote data, telemetry, an updater or any author execution capability. The source format remains `1.0`, the language contract `1.0-draft.3`, and the ABIs remain `tinta-ir-1`, `tinta-host-1` and `tinta-vscode-1`.

The machine-readable inputs are [release configuration](../toolchain/release.json), its [closed schema](../schemas/release-config.schema.json), and the [release manifest schema](../schemas/release-manifest.schema.json). Run `node scripts/distribution-package.mjs` after installing the frozen dependencies to rebuild and pack all targets under `build/distribution`. The command clears generated build and package output trees first. It creates local archives only; it does not upload them. Archive construction does not establish compatibility in every required environment or public availability.

## Names and destinations

The npm packages use the `@tinta-lang` scope. Source and downloads belong to `planta7/tinta` on GitHub, and the Marketplace extension ID is `planta7.tinta`. The CLI command and source profile remain `tinta`; ordinary Markdown remains `markdown`. Package and extension availability is independent of these configured identities.

Root, Studio, VS Code and every package's **source** manifest stay private, with their existing development versions. The only npm privacy exception is a generated manifest for one of the ten allowlisted npm targets, inside a clean `build/release-staging` output tree. It may have `private: false`, explicit public npm access, the selected implementation version and exact internal dependency versions. It must not contain workspace/file/link references, install scripts, credentials or unapproved dependencies. No source-manifest mutation, recursive directory discovery or blanket architecture-check bypass is permitted. The generated VSIX extension manifest is a separate non-npm artifact; it never makes `@tinta-lang/vscode` publishable.

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

The first implementation input is `0.1.0-dev.0`. All ten npm packages use that coordinated version with exact internal dependencies and explicit `next` dist-tag. Development integers increase for new intentionally distributed builds. The initial `0.1.0-dev.0` also retains the registry-created `latest` tag, so an unversioned npm install selects this prerelease until a stable release replaces that tag. A future stable implementation uses plain SemVer and `latest`; source-format `1.0` does not authorize stable software `1.0.0`. Build metadata and floating internal ranges are excluded. A changed version requires rebuilt, retested bytes. Moving a dist-tag for an unchanged version may reuse identical tarballs; it does not change embedded versions.

The first Marketplace version is numeric `0.1.0`, in the pre-release channel. Extension versions are independent of npm versions and record the embedded implementation version. Odd minor versions designate pre-release; even minor versions designate stable extension releases. A transition needs a distinct numeric version and compatible update ordering. Marketplace does not accept SemVer prerelease suffixes in extension versions; see [Microsoft's version rules](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions).

The local `tinta-local.tinta` artifact remains `0.1.0-dev.0`. Both local and distribution builds embed the implementation version from `toolchain/release.json`; private source manifests retain their development placeholders. The new public ID is a separate installation. Users must deliberately disable or uninstall the local extension before enabling the public one to avoid two active providers. Preserve documents and manually check settings; no automatic migration is promised.

A coordinated release identifier is `tinta-{implementation}-vscode-{extension}-{extensionChannel}`. Its immutable Git tag is `tinta-v{implementation}-vscode-{extension}-{extensionChannel}`. Both identify one full target set and one commit/tree. The manifest digest distinguishes candidate bytes; tags are never moved. A subset release needs a separately specified target/configuration change, not silent omission of a failing artifact. Repeated local builds do not allocate public versions or tags.

## Runtime compatibility

The Node target is `>=24.21.0 <25`, with exact baseline tests on 24.21.0 for macOS arm64, Linux arm64 and Windows x64. npm package checks include clean consumer installation, ESM imports and TypeScript resolution; Node-only APIs need native filesystem/IPC checks. Browser-capable libraries also need the three locked Playwright browser engines on macOS arm64. Browser worker support does not imply DOM availability in Node. Browser version fields in a produced manifest must contain actual engine versions, resolved from the pinned toolchain, rather than the configuration's `playwright-lock` selector.

VS Code Desktop requires `^1.141.0`; minimum and current tested baseline coincide at 1.141.0. The requested native matrix is macOS arm64, Linux arm64 and Windows x64, with installed VSIX authoring, trusted/restricted file workflows, preview, exports, responsiveness and offline behavior. Each candidate supplies its own results for those exact native targets, including OS-wide offline isolation. No architecture may inherit another architecture's result. Remote/SSH/container workspaces, virtual filesystems and vscode.dev remain unsupported.

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

The implementation version is generated into `@tinta-lang/types/version` after TypeScript compilation and before runtime bundling. The CLI, artifact writer, embedded reader, Studio and extension build identity consume that input. Interactive envelopes retain an exact implementation-version equality check. Source-format and protocol identifiers are independent of implementation versions.

The npm staging manifests provide ESM exports and declarations, an exact internal dependency graph and Node engine constraints. `@tinta-lang/reader/reader.css` exposes the required reader stylesheet. The CLI carries its bin launcher and standalone Studio resource. The language-server package exposes only `@tinta-lang/language-server/ipc`: resolve this path and launch it with Node `fork` and an IPC channel. Preserve the sibling `dist/worker.mjs`. It uses UTF-16 positions and full document synchronization; there is no stdio executable or root import.

`toolchain/distribution-source.json` is the exact source-file allowlist. Packaging rejects missing, additional or symbolic-link source entries, and source bytes must remain unchanged throughout the build. Content inspections reject private paths, credentials and source maps. The narrow source-test exceptions in `toolchain/distribution-source-exceptions.json` are exact line digests for deliberately hostile fixtures and detector expressions; they do not exempt whole source files. Every npm and download payload carries its own license and third-party notices.

ZIP entries have fixed timestamps and sorted names. npm archives use the pinned pnpm packer without lifecycle scripts in generated manifests. `inventory.json` records every archive size, SHA-256, SHA-512 integrity, unpacked file hash, complete frozen external dependency closure and source dirty state. It is a local content inventory, not a release attestation or installed-consumer test result. Generated packages include the repository configured for the release.

After constructing the archives, run `pnpm exec vitest run --config scripts/distribution-vitest.config.js` for packaging, corruption, parser-budget and IPC regressions. Installed consumer routes and platform compatibility require separate tests of the exact archives. Rebuilding under another implementation version produces a different payload and requires those tests again.

## Testing supplied archives

`node scripts/consumer-artifacts.mjs <inventory.json> <dependency-directory> <report.json>` tests supplied archives without rebuilding them. The inventory's sixteen archives must sit beside it. Every archive and member hash is checked before use; installed npm package files are checked again after the tests. Run with the pinned Node, npm 11.19.0, pnpm 10.34.6 and browser binaries. The harness uses the cached exact Corepack pnpm CLI, or an explicit `TINTA_CONSUMER_PNPM` path to that version's `bin/pnpm.cjs`. It records the CLI hash and rejects other versions. Automatic tool downloads are disabled. A native `tar` executable is required to read integrity-verified upstream package manifests.

Prepare dependency bytes separately with `node scripts/consumer-dependencies.mjs <inventory.json> <dependency-directory>`. It accepts existing archives or npm cache content only after matching their reviewed SHA-512 integrity. An explicit `--download` allows read-only acquisition from the fixed npm registry origin; it does not upload anything. The exact TypeScript and Node declaration tools come from the repository's reviewed lock inventory. No credentials are used.

The consumer harness loads verified tarballs into a sealed in-memory registry on an ephemeral `127.0.0.1` port. It has no upstream proxy or upload endpoint. npm and pnpm install the original dependency edges in separate temporary projects outside the checkout, with fresh caches, stores and configuration, no ambient `NODE_PATH`, and installation scripts disabled. Runtime checks require no registry requests. The test covers ESM exports, strict declaration resolution, parser budgets/recovery, evaluation, language queries, IPC/worker restart, CLI image boundaries, bundles, HTML and Studio resources. A disposable hook-removal fault demonstrates that an unpatched parser is rejected; original installed bytes are restored and rechecked.

Chromium, Firefox and WebKit exercise installed reader/chart code and standalone resources. Exported HTML and standalone Studio run at file origin in offline contexts. The Studio directory runs under a nested loopback path with nonlocal requests denied, checking relative resource lookup. These are browser-context checks, not proof of OS-wide network isolation. Temporary projects and the JSON report retain diagnostic evidence. Missing tools or browsers fail the command; a successful command covers only its recorded OS and architecture.

Use `node scripts/test-vscode-installed.mjs <desktop> <desktop-cli> <exact-vsix> <fresh-directory> --release` with each of `--workflow`, `--restricted` and `--performance` to test the same supplied distribution VSIX in isolated profiles. The installed harness also checks the bundled server's watchdog using a disposable stalled worker, then restores the production worker for recovery. `--os-offline` requests the stronger macOS isolation mode and fails if that environment cannot start. Native Linux/Windows and other architectures require independent runs; a local result cannot substitute for them.

## Automatic versions and release notes

Every push to a source branch runs `Verify language`. Pushes to `main` additionally produce a release candidate; successful completion starts `Publish release` automatically. Tags and the internal `publication-journal` branch do not schedule source CI. Opening a pull request does not repeat the branch push checks. A merged commit on `main` is a new source revision and receives its own checks.

`toolchain/automatic-release.json` defines a fixed Git baseline and the initial implementation and extension versions. The number of first-parent commits after that baseline is added to both patch versions. The resulting stable versions increase along `main`, preserve the extension's even minor number, and do not depend on wall-clock time, registry responses or workflow attempts. Failed runs can leave unused version numbers. Repeating a commit gives the same versions. Major/minor changes require an explicit change of the baseline policy; commit messages never silently claim compatibility. Source-format and protocol identifiers remain independent.

Release metadata is generated without editing tracked source or creating a version commit. `TINTA_RELEASE_SOURCE_SHA` selects the exact checked-out revision; full first-parent history is required and rewritten ancestry is rejected. Ordinary local builds continue to use `toolchain/release.json`. To reproduce a released version locally, check out its source commit with full history and set `TINTA_RELEASE_SOURCE_SHA` to that commit before building.

Release notes list the commit subjects and links from the push's previous revision through its new revision. Merge commits include their introduced commits. Markdown-sensitive characters are escaped. Force pushes are rejected for release production. The generated `release-plan.json` is hashed in the inventory and included in the signed candidate and release assets. Publication uses those notes unchanged. No request JSON, manually copied hash, release PR or changelog edit is required.

## CI and immutable artifacts

`verify.yml` checks formatting, lint, types, dependencies, specifications, source tests and browsers. Extension host and Studio tests share the unit run and retain their coverage thresholds. Extension preview browser tests run once. The Linux source run builds the application once and transfers that compilation to macOS/Windows CLI checks and the distribution packager. Platform tests cover distinct environments; they are not repeated by the publisher.

Only `main` packages the sixteen distribution targets. `distribution-package.mjs --built` consumes the verified compilation; the command without that option remains a clean local build. Distribution tests validate the supplied payloads. Native macOS arm64, Linux arm64 and Windows x64 jobs install the same npm archives and VSIX, exercising workflow, restricted, performance and OS-offline modes. The macOS job also checks all three browser engines against the supplied archives. No consumer job rebuilds payloads.

The build report records the successful source jobs from its own run, including their commit and attempt. Those jobs must complete before packaging. The producer workflow itself must complete successfully before CD acquires the candidate. Artifacts are addressed by immutable IDs and run/attempt-specific names, with storage digests, exact source identity and signed provenance. Candidates expire no later than the earliest underlying storage expiry, within 30 days. A missing, altered, expired or incomplete candidate stops publication.

## Automatic publication

`publish-release.yml` responds only to completed `Verify language` runs on `main`. Its gate requires a successful push from this repository, checks out that exact source commit, validates the candidate's storage and signature, and checks the complete native matrix. A privileged workflow never selects an artifact by an untrusted URL or executes candidate archive contents as publication code. The publishing job uses the `release` environment and OIDC. Repository branch protection and OIDC/environment bindings remain external prerequisites; environments must not require reviewers for unattended delivery.

The workflow derives the candidate run, attempt, source SHA and manifest digest automatically. It does not use `TINTA_REVIEWED_PUBLISHER_SHA` or `TINTA_RELEASE_INTENT`. Publication policy and verified account identities still apply. npm trusted publishers remain bound to `publish-release.yml` and `release`; no stored npm token fallback is used. Marketplace authentication exchanges the GitHub OIDC assertion through the configured Entra application. Changing account bindings is separate from changing source files.

The publisher uses the pinned npm 11.21.0 archive and dependency inventory, validates its integrity, and transfers tools without installation hooks into the write-capable job. npm uploads use a candidate-specific tag. Exact dependency versions are installed and compared with the supplied tarballs once per publication transaction. Marketplace receives the original VSIX; downloaded payloads must match except for the defined signature additions. Public visibility and anonymous download verification precede npm channel promotion. A candidate tag does not hide an npm version from users or version ranges.

The durable `publication-journal` branch records destination operations and uses non-force compare-and-swap writes and a run/attempt lease. Retries query destinations before writing and accept only identical existing content. A partially completed npm channel promotion resumes automatically only when every observed tag matches the recorded original or intended value; unexpected external changes stop the operation. Unknown outcomes, content collisions, expired candidates and attempts to move channels backwards fail explicitly. No automatic unpublish, deletion or overwrite occurs. Workflow concurrency queues up to 100 pending runs without canceling an active publication; service queue limits still apply. A failed destination can leave earlier uploads visible, so successful completion requires every destination to verify.

After npm, Marketplace and channel checks pass, GitHub receives the immutable source tag, original archives, release plan, manifest, provenance and matching generated notes. Studio deployment runs as downstream jobs in the same CD workflow and downloads the published Studio archive. It verifies release assets and signatures and checks that a newer stable release has not superseded it before deploying to Pages. Neither publication nor Pages runs CI or rebuilds the application. The deployment hosts the software demo, never authored documents.

Hosted credentials, environment protections, signature issuance and native OS isolation cannot be proven by local fixture tests. See [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [artifact attestations](https://github.com/actions/attest), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), and [Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
