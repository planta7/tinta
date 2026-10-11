import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import { parseDocument } from "yaml";
import { requireCommandSync } from "./commands.mjs";
import {
  loadReleaseConfig,
  validateConfig,
  sha256,
} from "./release-contract.mjs";

export const releasePaths = ["toolchain/release.json", "CHANGELOG.md"];
const versionKeys = [
  "implementation",
  "npmChannel",
  "extension",
  "extensionChannel",
];
const encode = (value) => JSON.stringify(value, null, 2) + "\n";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function keys(value, expected) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()),
    "Unexpected or missing input fields",
  );
}

export function readRequest(text) {
  requireValue(Buffer.byteLength(text) <= 32768, "Request is too large");
  // JSON syntax plus YAML's duplicate-key detection; no last-key-wins inputs.
  const value = JSON.parse(text);
  const document = parseDocument(text, { uniqueKeys: true });
  requireValue(document.errors.length === 0, "Duplicate request keys");
  return value;
}

export function prepareRelease(configBytes, changelog, published, request) {
  const baseline = validateConfig(JSON.parse(configBytes));
  keys(request, [
    "baselineSha256",
    "decision",
    "versions",
    "changes",
    "compatibility",
  ]);
  keys(request.versions, versionKeys);
  requireValue(
    request.baselineSha256 === sha256(configBytes),
    "Stale configuration or inventory",
  );
  requireValue(
    typeof request.decision === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 .:/_#-]{0,255}$/.test(request.decision),
    "A recorded version decision reference is required",
  );
  for (const field of ["changes", "compatibility"]) {
    requireValue(
      Array.isArray(request[field]) &&
        request[field].length > 0 &&
        request[field].length <= 30,
      `Expected ${field} notes`,
    );
    for (const line of request[field]) {
      requireValue(
        typeof line === "string" &&
          line.trim() === line &&
          line.length > 0 &&
          line.length <= 500 &&
          !/[<>]/.test(line) &&
          [...line].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        "Notes must be bounded plain-text lines",
      );
    }
  }
  const config = structuredClone(baseline);
  Object.assign(config.versions, request.versions);
  validateConfig(config);
  keys(published, ["implementation", "extension"]);
  for (const key of ["implementation", "extension"]) {
    const version = config.versions[key];
    requireValue(
      Array.isArray(published[key]) &&
        published[key].every(
          (v) => typeof v === "string" && semver.valid(v) === v,
        ),
      "Invalid published-version inventory",
    );
    requireValue(
      semver.gte(version, baseline.versions[key]),
      `Version must not decrease: ${key}`,
    );
    requireValue(
      !published[key].includes(version),
      `Already published: ${key}`,
    );
    requireValue(
      published[key].every((v) => semver.gt(version, v)),
      `Version precedes published identity: ${key}`,
    );
  }
  requireValue(
    changelog.startsWith("# Changelog\n\n"),
    "Invalid changelog header",
  );
  const { implementation, extension, npmChannel, extensionChannel } =
    config.versions;
  const heading = `## ${implementation} / VS Code ${extension}`;
  requireValue(
    !changelog.includes(heading + "\n"),
    "Duplicate changelog identity",
  );
  const entry = [
    heading,
    "",
    `npm channel: ${npmChannel}. Extension channel: ${extensionChannel}.`,
    "",
    ...request.changes.map((line) => `- ${line}`),
    "",
    "### Compatibility",
    "",
    ...request.compatibility.map((line) => `- ${line}`),
    "",
    "",
  ].join("\n");
  // Preserve every byte outside the version object, including inventory layout.
  const oldVersions = encode(baseline.versions)
    .trimEnd()
    .replaceAll("\n", "\n  ");
  const newVersions = encode(config.versions)
    .trimEnd()
    .replaceAll("\n", "\n  ");
  const needle = `"versions": ${oldVersions}`;
  requireValue(
    configBytes.split(needle).length === 2,
    "Unsupported configuration layout",
  );
  const contents = {
    "toolchain/release.json": configBytes.replace(
      needle,
      `"versions": ${newVersions}`,
    ),
    "CHANGELOG.md":
      "# Changelog\n\n" + entry + changelog.slice("# Changelog\n\n".length),
  };
  const originals = {
    "toolchain/release.json": configBytes,
    "CHANGELOG.md": changelog,
  };
  const files = Object.fromEntries(
    Object.entries(contents).filter(
      ([path, content]) => content !== originals[path],
    ),
  );
  const dependencies = config.packages.map((target) => ({
    name: target.proposedName,
    version: implementation,
    dependencies: Object.fromEntries(
      target.dependencies.map((id) => [
        config.packages.find((item) => item.id === id).proposedName,
        implementation,
      ]),
    ),
  }));
  return { files, dependencies, decision: request.decision };
}

export function prepareCheckout(request, directory = process.cwd()) {
  const git = (...args) =>
    requireCommandSync(["git", ...args], { cwd: directory }).stdout;
  const baseline = (path) => git("show", `HEAD:${path}`);
  const plan = prepareRelease(
    baseline(releasePaths[0]),
    baseline(releasePaths[1]),
    JSON.parse(baseline("toolchain/published-versions.json")),
    request,
  );
  // Check all destinations before any write; never replace unrelated edits or links.
  for (const path of releasePaths) {
    const destination = resolve(directory, path);
    requireValue(
      lstatSync(destination).isFile() &&
        !lstatSync(destination).isSymbolicLink(),
      `Unsafe destination: ${path}`,
    );
    const current = readFileSync(destination, "utf8");
    requireValue(
      current === baseline(path) || current === plan.files[path],
      `Unrelated changes: ${path}`,
    );
  }
  for (const path of Object.keys(plan.files))
    writeFileSync(resolve(directory, path), plan.files[path]);
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  requireValue(
    process.argv.length === 3,
    "Usage: node scripts/prepare-release.mjs <request.json>",
  );
  loadReleaseConfig();
  const plan = prepareCheckout(
    readRequest(readFileSync(process.argv[2], "utf8")),
  );
  console.log(
    encode({
      changedFiles: Object.keys(plan.files),
      dependencies: plan.dependencies,
    }),
  );
}
