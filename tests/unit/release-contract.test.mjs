import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import semver from "semver";
import {
  dependencyClosure,
  loadReleaseConfig,
  releaseIdentity,
  sha256,
  validateConfig,
  validateReleaseManifest,
} from "../../scripts/release-contract.mjs";

const config = loadReleaseConfig();
const configBytes = readFileSync("toolchain/release.json");
const digests = {
  configSha256: sha256(configBytes),
  lockSha256: sha256(readFileSync("pnpm-lock.yaml")),
};
const hash = "a".repeat(64);
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
const file = (path) => ({ path, bytes: 100, sha256: hash, integrity });

// Synthetic metadata exercises validation; it is not a built release candidate.
function manifestFixture() {
  const targets = [...config.packages, ...config.artifacts].map((target) => {
    const npm = config.packages.includes(target);
    const extension = target.id === "vscode";
    const suffix = npm ? "tgz" : extension ? "vsix" : "zip";
    return {
      id: target.id,
      kind: npm ? "npm" : target.kind,
      name: npm ? target.proposedName : extension ? "planta7.tinta" : target.id,
      version: extension
        ? config.versions.extension
        : config.versions.implementation,
      channel: extension
        ? config.versions.extensionChannel
        : config.versions.npmChannel,
      dependencies: target.dependencies.map((id) => ({
        name: config.packages.find((item) => item.id === id).proposedName,
        version: config.versions.implementation,
      })),
      embeddedTargets: target.embeddedTargets,
      externalDependencies: target.externalDependencies,
      archive: file(`archives/${target.id}.${suffix}`),
      licenses: ["LICENSE", "THIRD_PARTY_NOTICES.txt"].map((path) => ({
        path,
        sha256: hash,
      })),
      environments: target.environments,
    };
  });
  return structuredClone({
    schemaVersion: 1,
    ...releaseIdentity(config),
    source: { commit: "a".repeat(40), tree: "b".repeat(40), ...digests },
    versions: config.versions,
    targets,
    toolchain: ["node", "pnpm", "typescript", "esbuild", "playwright"].map(
      (name) => ({
        name,
        version: "1.0.0",
        integrity,
      }),
    ),
    verification: {
      provider: "local",
      runId: "synthetic-contract-test",
      attempt: 1,
      environments: config.environments.map((environment) => ({
        ...environment,
        osVersion: "synthetic-os-version",
        runtimeIntegrity: "synthetic-runtime-integrity",
        version:
          environment.version === "playwright-lock"
            ? "123.0.0"
            : environment.version === "inventory"
              ? "1"
              : environment.version,
      })),
      results: targets.flatMap((target) =>
        target.environments.map((environment) => ({
          target: target.id,
          environment,
          status: "not-run",
          checks: ["synthetic-metadata-only"],
          report: file(`reports/${target.id}-${environment}.json`),
        })),
      ),
    },
    limitations: [
      "Synthetic metadata; no archives built or tests of artifacts performed.",
    ],
  });
}

const validate = (manifest) =>
  validateReleaseManifest(manifest, config, digests);

describe("software distribution contract", () => {
  it("matches all ten private source package dependency sets", () => {
    expect(config.packages).toHaveLength(10);
    expect(config.artifacts).toHaveLength(6);
    expect(config.policy.externalActivation).toBe(true);
    expect(config.identities.repository.value).toBe("planta7/tinta");
    expect(config.identities.npmScope.value).toBe("@tinta-lang");
    expect(config.identities.marketplacePublisher.value).toBe("planta7");
    expect(config.identities.extensionName.value).toBe("tinta");
  });

  it("closes CLI, patched parser, Studio and embedded reader dependencies", () => {
    expect(dependencyClosure(config, "cli")).toEqual(
      expect.arrayContaining([
        "local-files",
        "syntax",
        "artifacts",
        "reader-runtime",
        "studio-standalone",
      ]),
    );
    expect(dependencyClosure(config, "vscode")).toContain("language-server");
  });

  it.each([
    [
      "unknown config field",
      (c) => {
        c.publish = true;
      },
    ],
    [
      "duplicate target",
      (c) => {
        c.packages[1] = c.packages[0];
      },
    ],
    [
      "missing package",
      (c) => {
        c.packages.pop();
      },
    ],
    [
      "unapproved package",
      (c) => {
        c.packages[0].id = "studio";
      },
    ],
    [
      "cycle",
      (c) => {
        c.packages[0].dependencies = ["cli"];
      },
    ],
    [
      "embedding cycle",
      (c) => {
        c.artifacts[3].embeddedTargets = ["reader-runtime"];
      },
    ],
    [
      "missing environment",
      (c) => {
        c.environments.pop();
      },
    ],
    [
      "unknown nested property",
      (c) => {
        c.versions.extra = "1";
      },
    ],
    [
      "stable tag for development version",
      (c) => {
        c.versions.implementation = "0.1.0-dev.0";
        c.versions.npmChannel = "latest";
      },
    ],
    [
      "suffix in extension version",
      (c) => {
        c.versions.extension = "0.1.0-dev.0";
      },
    ],
    [
      "stable channel with odd minor",
      (c) => {
        c.versions.extension = "0.1.0";
        c.versions.extensionChannel = "stable";
      },
    ],
    [
      "external activation with an unverified identity",
      (c) => {
        c.policy.externalActivation = true;
        c.identities.npmScope.status = "proposed";
      },
    ],
    [
      "source privacy bypass",
      (c) => {
        c.policy.sourceManifestsPrivate = false;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const candidate = structuredClone(config);
    mutate(candidate);
    expect(() => validateConfig(candidate)).toThrow();
  });

  it("rejects an unset publisher or an unsupported ownership state", () => {
    const candidate = structuredClone(config);
    candidate.identities.marketplacePublisher.value = null;
    expect(() => validateConfig(candidate)).toThrow();
    candidate.identities.marketplacePublisher.value = "tinta";
    candidate.identities.marketplacePublisher.status = "claimed";
    expect(() => validateConfig(candidate)).toThrow();
  });

  it.each(["identities", "packages", "artifacts"])(
    "requires every %s identity for external activation",
    (group) => {
      for (const key of Object.keys(config[group])) {
        const candidate = structuredClone(config);
        const field = group === "identities" ? "status" : "identityStatus";
        candidate[group][key][field] = "proposed";
        expect(() => validateConfig(candidate)).toThrow(/Unverified/);
        candidate.policy.externalActivation = false;
        expect(validateConfig(candidate)).toBe(candidate);
      }
    },
  );

  it("rejects a reduced target environment matrix", () => {
    const candidate = structuredClone(config);
    candidate.packages[0].environments.pop();
    expect(() => validateConfig(candidate)).toThrow(/environments/);
  });

  it("rejects source publication and stale dependency inventories", () => {
    const manifests = Object.fromEntries(
      [
        ".",
        "apps/studio",
        "apps/vscode",
        ...config.packages.map((p) => p.source),
      ].map((path) => [
        path,
        JSON.parse(readFileSync(`${path}/package.json`, "utf8")),
      ]),
    );
    manifests["."].private = false;
    expect(() => validateConfig(config, manifests)).toThrow(/private/);
    manifests["."].private = true;
    manifests["packages/cli"].dependencies["@tinta-lang/reader"] =
      "workspace:*";
    expect(() => validateConfig(config, manifests)).toThrow(/dependencies/);
  });

  it("accepts a future stable version mapping without authorizing activation", () => {
    const candidate = structuredClone(config);
    candidate.policy.externalActivation = false;
    candidate.versions.implementation = "0.2.0";
    candidate.versions.npmChannel = "latest";
    candidate.versions.extension = "0.2.0";
    candidate.versions.extensionChannel = "stable";
    expect(validateConfig(candidate).policy.externalActivation).toBe(false);
  });
});

describe("release manifest metadata", () => {
  it("represents an entire unverified inventory without claiming success", () => {
    const manifest = manifestFixture();
    expect(validate(manifest)).toBe(manifest);
    expect(
      manifest.verification.results.every((item) => item.status === "not-run"),
    ).toBe(true);
  });

  it("rejects changed external pins", () => {
    const manifest = manifestFixture();
    manifest.targets[0].externalDependencies["fflate"] = "0.8.0";
    expect(() => validate(manifest)).toThrow(/external dependency/);
  });

  it("preserves blocked and failed observations", () => {
    const manifest = manifestFixture();
    manifest.verification.results[0].status = "blocked";
    manifest.verification.results[1].status = "failed";
    expect(validate(manifest)).toBe(manifest);
  });

  it.each([
    [
      "self digest",
      (m) => {
        m.sha256 = hash;
      },
    ],
    [
      "unknown source key",
      (m) => {
        m.source.dirty = false;
      },
    ],
    [
      "missing target",
      (m) => {
        m.targets.pop();
      },
    ],
    [
      "duplicate target",
      (m) => {
        m.targets[1] = m.targets[0];
      },
    ],
    [
      "mixed versions",
      (m) => {
        m.targets[0].version = semver.inc(m.targets[0].version, "patch");
        expect(m.targets[0].version).not.toBe(m.versions.implementation);
      },
    ],
    [
      "wrong contract",
      (m) => {
        m.versions.contract = "1.0-draft.2";
      },
    ],
    [
      "workspace dependency",
      (m) => {
        m.targets[1].dependencies[0].version = "workspace:*";
      },
    ],
    [
      "missing dependency",
      (m) => {
        m.targets[1].dependencies = [];
      },
    ],
    [
      "missing embedded runtime",
      (m) => {
        m.targets[5].embeddedTargets = [];
      },
    ],
    [
      "wrong identity",
      (m) => {
        m.targets[0].name = "@other/types";
      },
    ],
    [
      "wrong tag",
      (m) => {
        m.tag = "v1.0.0";
      },
    ],
    [
      "wrong config hash",
      (m) => {
        m.source.configSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong lock hash",
      (m) => {
        m.source.lockSha256 = "0".repeat(64);
      },
    ],
    [
      "abbreviated source identity",
      (m) => {
        m.source.commit = "abc123";
      },
    ],
    [
      "mixed Git algorithms",
      (m) => {
        m.source.tree = hash;
      },
    ],
    [
      "missing license",
      (m) => {
        m.targets[0].licenses.pop();
      },
    ],
    [
      "duplicate archive",
      (m) => {
        m.targets[1].archive = m.targets[0].archive;
      },
    ],
    [
      "negative size",
      (m) => {
        m.targets[0].archive.bytes = -1;
      },
    ],
    [
      "empty archive",
      (m) => {
        m.targets[0].archive.bytes = 0;
      },
    ],
    [
      "unsafe integer",
      (m) => {
        m.targets[0].archive.bytes = 2 ** 53;
      },
    ],
    [
      "invalid integrity",
      (m) => {
        m.targets[0].archive.integrity = "sha512-fake";
      },
    ],
    [
      "wrong archive type",
      (m) => {
        m.targets[0].archive.path = "types.zip";
      },
    ],
    [
      "missing environment result",
      (m) => {
        m.verification.results.pop();
      },
    ],
    [
      "duplicate result",
      (m) => {
        m.verification.results.push(m.verification.results[0]);
      },
    ],
    [
      "invented architecture",
      (m) => {
        m.verification.environments[0].architecture = "x64";
      },
    ],
    [
      "missing toolchain",
      (m) => {
        m.toolchain.pop();
      },
    ],
    [
      "invalid attempt",
      (m) => {
        m.verification.attempt = 0;
      },
    ],
    [
      "report aliases payload",
      (m) => {
        m.verification.results[0].report = m.targets[0].archive;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const manifest = manifestFixture();
    mutate(manifest);
    expect(() => validate(manifest)).toThrow();
  });

  it.each([
    "../types.tgz",
    "/types.tgz",
    "C:\\types.tgz",
    "a/../types.tgz",
    "https://host/types.tgz",
  ])("rejects unsafe archive path %s", (path) => {
    const manifest = manifestFixture();
    manifest.targets[0].archive.path = path;
    expect(() => validate(manifest)).toThrow();
  });
});
