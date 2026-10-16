import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { requireCommandSync } from "./commands.mjs";

export function coordinatedVersions(previous, recommended) {
  assert.ok(semver.valid(previous.implementation));
  assert.ok(semver.valid(previous.extension));
  assert.equal(semver.minor(previous.extension) % 2, 0);
  assert.ok(
    semver.valid(recommended) &&
      semver.gt(recommended, previous.implementation),
  );
  const implementation =
    semver.major(previous.implementation) === 0 && semver.major(recommended) > 0
      ? semver.inc(previous.implementation, "minor")
      : recommended;
  const impact = semver.diff(previous.implementation, recommended);
  const extension =
    impact === "minor" ||
    (impact === "major" && semver.major(previous.extension) === 0)
      ? `${semver.major(previous.extension)}.${semver.minor(previous.extension) + 2}.0`
      : semver.inc(previous.extension, impact);
  assert.ok(semver.valid(implementation) && semver.valid(extension));
  return {
    implementation,
    extension,
    npmChannel: "latest",
    extensionChannel: "stable",
  };
}

export function readReleaseVersions(
  sourceSha,
  path = "reports/release/plan.json",
) {
  const plan = JSON.parse(readFileSync(path, "utf8"));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(plan.sourceSha, sourceSha, "Release plan checkout mismatch");
  return Object.fromEntries(
    ["implementation", "extension", "npmChannel", "extensionChannel"].map(
      (key) => [key, plan[key]],
    ),
  );
}

export function generateReleasePlan(cwd = process.cwd()) {
  const run = (command, options = {}) =>
    requireCommandSync(command, { cwd, ...options }).stdout.trim();
  const git = (...args) => run(["git", ...args]);
  const sourceSha = git("rev-parse", "HEAD");
  if (process.env.TINTA_RELEASE_SOURCE_SHA)
    assert.equal(sourceSha, process.env.TINTA_RELEASE_SOURCE_SHA);
  const tag = git(
    "describe",
    "--tags",
    "--match=tinta-v*-vscode-*-stable",
    "--abbrev=0",
  );
  const match = /^tinta-v(\d+\.\d+\.\d+)-vscode-(\d+\.\d+\.\d+)-stable$/.exec(
    tag,
  );
  assert.ok(match, "Expected a stable coordinated release tag");
  const previous = { implementation: match[1], extension: match[2] };
  const directory = join(cwd, "reports/release");
  mkdirSync(directory, { recursive: true });
  // The tool reads this private input instead of mutating a source manifest.
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "tinta-release-input",
      private: true,
      version: previous.implementation,
    }),
  );
  const cli = fileURLToPath(
    new URL(
      "bin/release-it.js",
      import.meta.resolve("release-it/package.json"),
    ),
  );
  const config = fileURLToPath(
    new URL("../toolchain/release-it.json", import.meta.url),
  );
  const tool = (...args) =>
    run(
      [process.execPath, cli, "--config", config, "--ci", "--quiet", ...args],
      { cwd: directory },
    );
  const recommended = tool("--release-version");
  const versions = recommended
    ? coordinatedVersions(previous, recommended)
    : { ...previous, npmChannel: "latest", extensionChannel: "stable" };
  const plan = {
    sourceSha,
    before: git("rev-parse", `${tag}^{commit}`),
    publish: Boolean(recommended),
    ...versions,
    tag: `tinta-v${versions.implementation}-vscode-${versions.extension}-stable`,
    notes: recommended
      ? tool(versions.implementation, "--changelog")
      : "No release changes.",
  };
  writeFileSync(
    join(directory, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  writeFileSync(join(directory, "notes.md"), plan.notes + "\n");
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const plan = generateReleasePlan();
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `publish=${plan.publish}\ntag=${plan.tag}\n`,
    );
}
