# Foundation toolchain

Use Node 24.21.0 and pnpm 10.34.6. Install with `pnpm install --frozen-lockfile`, then install the pinned browser builds with `pnpm exec playwright install chromium firefox webkit`. Linux CI also uses `--with-deps`. Run `pnpm verify` (or `pnpm verify --suite infrastructure`) from the repository root. The verification command needs npm advisory endpoint access; an unavailable endpoint fails the gate.

The eight workspace packages contain empty exported modules. They implement no document operations. `pnpm test:unit` tests infrastructure and helper import compatibility; `pnpm test:browser:infrastructure` tests offline file imports and classic reader/worker scaffolds in three engines. `pnpm test:conformance` and `pnpm test:browser` intentionally exit nonzero with `NOT_IMPLEMENTED` because no product suites exist yet. The infrastructure aggregate selects only infrastructure; unknown aggregate suites fail. No command reads private progress records.

`pnpm build` emits ESM declarations/modules, a reader IIFE and stylesheet, a classic worker scaffold and a standalone foundation HTML file under `build/`. Vite's development scaffold is separately built under `apps/studio/dist/`; its chunks are not standalone artifacts. Neither scaffold can open, compile, render or edit Tinta documents. Vite development/preview binds to loopback. Only esbuild's dependency build script is permitted during installation.

`dependencies.json` records direct official npm metadata selected under the approved release lines. `lock-inventory.json` records official metadata and integrity for every locked package, including optional platform packages. `node.json` pins the baseline archive checked on macOS arm64. `browsers.json` pins Playwright's browser revisions and platform overrides. `actions.json` records official action tag resolution and definition inspection. The transitive integrity lock is `pnpm-lock.yaml`.

`pnpm check:licenses` verifies the complete locked license inventory and that all installed notices are preserved in `THIRD_PARTY_NOTICES.txt`. The notices include development tools, not just product dependencies. To regenerate after an authorized dependency change, run `pnpm check:licenses --write` and review the result. Platform-specific binaries use their matching parent project's license text; the complete set of platform names is retained in the inventory. A platform may install a subset without removing other platforms' notices.

Reviewed notice sources: esbuild and rolldown native packages use the same-version parent licenses; lightningcss bindings use the matching lightningcss license. esrecurse and imurmurhash include full notices in their READMEs. natural-compare's README supplies its copyright and MIT designation; the standard MIT text is reproduced with that attribution. `@humanfs/types` declares Apache-2.0 in its manifest/README and uses the humanfs core project's license. These are unchanged third-party packages. MPL-2.0 dependencies (axe tools and lightningcss) are confined to test/build tooling; the checker rejects new MPL package identities for review. BlueOak-1.0.0 text from minimatch is included alongside MIT, ISC, BSD and Apache notices. No third-party license is replaced by the repository's MIT license.

Infrastructure coverage applies to the architecture scanner, capability selection and packaging primitives, with 85% statements/lines/functions and 80% branches. Build orchestration, inventory command-line scripts and configuration are exercised by their explicit aggregate commands. Empty product modules and type-only contracts do not count as runtime coverage. Product coverage thresholds remain as specified in the verification contract.

CI performs verification only on pull requests and pushes to the repository's configured default branch. It has read-only repository permissions, does not retain checkout credentials, and performs no deployment, package publication or artifact upload. Hosted CI execution and manual device acceptance are separate from local automated results.

## Local Linux verification

When a native browser cannot start on macOS, run the unchanged infrastructure suite in the pinned official Playwright Linux image:

```sh
docker build --file docker/verify.Dockerfile --tag tinta-verify:local .
docker run --rm --init --shm-size=1g tinta-verify:local
```

Docker Desktop must be running. The image is pinned by digest, checks Node 24.21.0, installs pnpm 10.34.6 and uses the frozen lockfile. Tests run as the unprivileged `pwuser`. The build context includes public project inputs and excludes private automation, Git metadata, dependencies and build outputs. There are no host mounts, published ports or permission changes in these commands. The run prints the complete result; preserve its output when recording verification evidence.

A successful Linux run qualifies that environment only. Native macOS Firefox can fail before tests with `Could not find profile folder` because macOS app-data protection denies initialization even with an existing temporary profile. See [Mozilla's startup issue](https://bugzilla.mozilla.org/show_bug.cgi?id=2060476). Keep native failures separate from Linux results; do not skip Firefox or replace its pinned build. The container workflow does not repair or change macOS privacy permissions.
