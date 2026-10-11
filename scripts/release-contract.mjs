import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import semver from "semver";

const root = new URL("../", import.meta.url);
const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const configShape = ajv.compile(readJson("schemas/release-config.schema.json"));
const manifestShape = ajv.compile(
  readJson("schemas/release-manifest.schema.json"),
);

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function shape(validate, value) {
  requireValue(validate(value), ajv.errorsText(validate.errors));
}

function same(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `Mismatch: ${label}`);
}

function unique(values, label) {
  requireValue(new Set(values).size === values.length, `Duplicate ${label}`);
}

function versionPolicy(versions) {
  const implementation = semver.parse(versions.implementation);
  requireValue(implementation !== null, "Invalid implementation version");
  const development = implementation.prerelease.length > 0;
  same(versions.npmChannel, development ? "next" : "latest", "npm channel");
  const extension = semver.parse(versions.extension);
  requireValue(extension !== null, "Invalid extension version");
  same(
    extension.minor % 2,
    versions.extensionChannel === "pre-release" ? 1 : 0,
    "extension channel parity",
  );
}

export function releaseIdentity(config) {
  const { implementation, extension, extensionChannel } = config.versions;
  return {
    releaseId: `tinta-${implementation}-vscode-${extension}-${extensionChannel}`,
    tag: `${config.policy.tagPrefix}${implementation}-vscode-${extension}-${extensionChannel}`,
  };
}

/** Check the declared graph, including resources embedded rather than imported. */
export function dependencyClosure(config, id) {
  const targets = new Map(
    [...config.packages, ...config.artifacts].map((target) => [
      target.id,
      target,
    ]),
  );
  const visiting = new Set();
  const visited = new Set();
  function visit(current) {
    requireValue(!visiting.has(current), `Dependency cycle: ${current}`);
    if (visited.has(current)) return;
    const target = targets.get(current);
    requireValue(target, `Missing target: ${current}`);
    visiting.add(current);
    for (const dependency of [
      ...target.dependencies,
      ...target.embeddedTargets,
    ])
      visit(dependency);
    visiting.delete(current);
    visited.add(current);
  }
  visit(id);
  return [...visited];
}

export function validateConfig(config, manifests) {
  shape(configShape, config);
  versionPolicy(config.versions);
  const targets = [...config.packages, ...config.artifacts];
  unique(
    targets.map((target) => target.id),
    "target",
  );
  unique(
    config.packages.map((target) => target.proposedName),
    "package name",
  );
  unique(
    config.environments.map((environment) => environment.id),
    "environment",
  );
  const environments = new Set(config.environments.map((item) => item.id));
  const expectedEnvironments = [
    ...["node", "vscode"].flatMap((runtime) => [
      `${runtime}-darwin-arm64`,
      `${runtime}-linux-arm64`,
      `${runtime}-win32-x64`,
    ]),
    "chromium-darwin-arm64",
    "firefox-darwin-arm64",
    "webkit-darwin-arm64",
    "source-inventory",
  ];
  same(
    [...environments].sort(),
    expectedEnvironments.sort(),
    "required environment inventory",
  );
  for (const environment of config.environments) {
    const id =
      environment.runtime === "source"
        ? "source-inventory"
        : `${environment.runtime}-${environment.platform}-${environment.architecture}`;
    same(environment.id, id, "environment identity");
  }
  same(config.identities.npmScope.value, "@tinta-lang", "proposed scope");
  for (const target of targets) {
    const requiredRuntimes = config.packages.includes(target)
      ? ["node"]
      : target.id === "vscode"
        ? ["vscode"]
        : target.id === "source"
          ? ["source"]
          : ["chromium", "firefox", "webkit"];
    if (
      config.packages.includes(target) &&
      !["cli", "local-files", "language-server"].includes(target.id)
    )
      requiredRuntimes.push("chromium", "firefox", "webkit");
    const requiredEnvironments = config.environments
      .filter((environment) => requiredRuntimes.includes(environment.runtime))
      .map((environment) => environment.id);
    same(
      target.environments.toSorted(),
      requiredEnvironments.toSorted(),
      "required target environments",
    );
    dependencyClosure(config, target.id);
    for (const id of target.environments)
      requireValue(environments.has(id), `Missing environment: ${id}`);
  }
  if (manifests) {
    for (const [path, manifest] of Object.entries(manifests))
      requireValue(
        manifest.private === true,
        `Source manifest must stay private: ${path}`,
      );
    for (const target of config.packages) {
      same(target.source, `packages/${target.id}`, "package source");
      const manifest = manifests[target.source];
      requireValue(manifest, `Missing source manifest: ${target.source}`);
      same(target.proposedName, manifest.name, "package identity");
      same(
        target.dependencies.toSorted(),
        Object.keys(manifest.dependencies ?? {})
          .filter((name) => name.startsWith("@tinta-lang/"))
          .map((name) => name.slice("@tinta-lang/".length))
          .sort(),
        `dependencies for ${target.id}`,
      );
      same(
        target.externalDependencies,
        Object.fromEntries(
          Object.entries(manifest.dependencies ?? {}).filter(
            ([name]) => !name.startsWith("@tinta-lang/"),
          ),
        ),
        `external dependencies for ${target.id}`,
      );
    }
    for (const artifact of config.artifacts) {
      const manifest = manifests[artifact.source];
      if (manifest) {
        same(
          artifact.externalDependencies,
          Object.fromEntries(
            Object.entries(manifest.dependencies ?? {}).filter(
              ([name]) => !name.startsWith("@tinta-lang/"),
            ),
          ),
          `artifact external dependencies for ${artifact.id}`,
        );
      }
    }
    for (const app of ["vscode", "studio"]) {
      const manifest = manifests[`apps/${app}`];
      requireValue(manifest, `Missing application: ${app}`);
      const closure = dependencyClosure(
        config,
        app === "studio" ? "studio-directory" : app,
      );
      for (const name of Object.keys(manifest.dependencies ?? {}))
        if (name.startsWith("@tinta-lang/"))
          requireValue(
            closure.includes(name.slice("@tinta-lang/".length)),
            `Missing application dependency: ${name}`,
          );
    }
  }
  return config;
}

export function loadReleaseConfig() {
  const config = readJson("toolchain/release.json");
  const paths = [
    ".",
    "apps/studio",
    "apps/vscode",
    ...config.packages.map((p) => p.source),
  ];
  const manifests = Object.fromEntries(
    paths.map((path) => [path, readJson(`${path}/package.json`)]),
  );
  return validateConfig(config, manifests);
}

/** Validate metadata only. This does not inspect archives or authorize uploads. */
export function validateReleaseManifest(manifest, config, digests) {
  validateConfig(config);
  shape(manifestShape, manifest);
  same(manifest.versions, config.versions, "release versions");
  const identity = releaseIdentity(config);
  same(manifest.releaseId, identity.releaseId, "release identity");
  same(manifest.tag, identity.tag, "release tag");
  same(manifest.source.configSha256, digests.configSha256, "config digest");
  same(manifest.source.lockSha256, digests.lockSha256, "lock digest");
  requireValue(
    manifest.source.commit.length === manifest.source.tree.length,
    "Mixed Git hash algorithms",
  );
  const targets = [...config.packages, ...config.artifacts];
  unique(
    manifest.targets.map((target) => target.id),
    "manifest target",
  );
  same(
    manifest.targets.map((target) => target.id).sort(),
    targets.map((target) => target.id).sort(),
    "target inventory",
  );
  const environments = manifest.verification.environments;
  unique(
    environments.map((item) => item.id),
    "verification environment",
  );
  same(
    environments.map((item) => item.id).sort(),
    config.environments.map((item) => item.id).sort(),
    "environment inventory",
  );
  for (const expected of config.environments) {
    const actual = environments.find((item) => item.id === expected.id);
    for (const field of ["runtime", "platform", "architecture"])
      same(actual[field], expected[field], `environment ${field}`);
    if (!["playwright-lock", "inventory"].includes(expected.version))
      same(actual.version, expected.version, "runtime version");
    else
      requireValue(
        actual.version !== expected.version,
        "Exact observed environment version required",
      );
  }
  unique(
    manifest.toolchain.map((item) => item.name),
    "toolchain entry",
  );
  for (const name of ["node", "pnpm", "typescript", "esbuild", "playwright"])
    requireValue(
      manifest.toolchain.some((item) => item.name === name),
      `Missing toolchain: ${name}`,
    );
  const files = new Map();
  function fileIdentity(file) {
    const existing = files.get(file.path);
    if (existing) same(file, existing, "shared report identity");
    files.set(file.path, file);
  }
  unique(
    manifest.targets.map((target) => target.archive.path),
    "archive path",
  );
  for (const expected of targets) {
    const target = manifest.targets.find((item) => item.id === expected.id);
    const isPackage = config.packages.includes(expected);
    const isExtension = target.id === "vscode";
    same(target.kind, isPackage ? "npm" : expected.kind, "target kind");
    same(
      target.externalDependencies,
      expected.externalDependencies,
      "external dependency pins",
    );
    same(
      target.name,
      isPackage
        ? expected.proposedName
        : isExtension
          ? `${config.identities.marketplacePublisher.value}.${config.identities.extensionName.value}`
          : expected.id,
      "target identity",
    );
    same(
      target.version,
      isExtension ? config.versions.extension : config.versions.implementation,
      "target version",
    );
    same(
      target.channel,
      isExtension
        ? config.versions.extensionChannel
        : config.versions.npmChannel,
      "target channel",
    );
    same(
      target.environments.toSorted(),
      expected.environments.toSorted(),
      "target environments",
    );
    same(
      target.embeddedTargets.toSorted(),
      expected.embeddedTargets.toSorted(),
      "embedded targets",
    );
    same(
      target.dependencies,
      expected.dependencies.map((id) => ({
        name: config.packages.find((item) => item.id === id).proposedName,
        version: config.versions.implementation,
      })),
      "exact internal dependencies",
    );
    requireValue(target.archive.bytes > 0, "Empty archive");
    const suffix = isPackage ? ".tgz" : isExtension ? ".vsix" : ".zip";
    requireValue(
      target.archive.path.endsWith(suffix),
      "Archive extension mismatch",
    );
    unique(
      target.licenses.map((license) => license.path),
      "license path",
    );
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
      requireValue(
        target.licenses.some((item) => item.path === name),
        `Missing license: ${name}`,
      );
    fileIdentity(target.archive);
  }
  const results = manifest.verification.results;
  unique(
    results.map((item) => `${item.target}/${item.environment}`),
    "verification result",
  );
  const expectedResults = targets.flatMap((target) =>
    target.environments.map((id) => `${target.id}/${id}`),
  );
  same(
    results.map((item) => `${item.target}/${item.environment}`).sort(),
    expectedResults.sort(),
    "verification matrix",
  );
  for (const result of results) {
    requireValue(
      !manifest.targets.some(
        (target) => target.archive.path === result.report.path,
      ),
      "Report aliases archive",
    );
    fileIdentity(result.report);
  }
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const config = loadReleaseConfig();
  console.log(
    `Release contract valid: ${config.packages.length} npm targets, ${config.artifacts.length} artifact targets; identities proposed, external activation disabled.`,
  );
}
