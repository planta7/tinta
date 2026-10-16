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
import { requireCommandSync, runCommandSync } from "./commands.mjs";

export const releaseComponents = JSON.parse(
  readFileSync(new URL("../toolchain/components.json", import.meta.url)),
);
const names = Object.keys(releaseComponents);
const pathspec = (component) => `:(top,attr:ci-${component})`;
const run = (cwd, command) =>
  requireCommandSync(command, { cwd }).stdout.trim();
const git = (cwd, ...args) => run(cwd, ["git", ...args]);

export function affectedComponents(before, sourceSha, cwd = process.cwd()) {
  assert.match(before, /^[a-f0-9]{40}$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  return names.filter((component) => {
    if (/^0+$/.test(before)) return true;
    const result = runCommandSync(
      [
        "git",
        "diff",
        "--quiet",
        "--no-renames",
        before,
        sourceSha,
        "--",
        pathspec(component),
      ],
      { cwd },
    );
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result.status === 1;
  });
}

export function nextComponentVersion(component, previous, recommended) {
  assert.ok(names.includes(component));
  assert.ok(semver.valid(previous));
  assert.ok(semver.valid(recommended) && semver.gt(recommended, previous));
  if (component === "vscode") assert.equal(semver.minor(previous) % 2, 0);
  const impact = semver.diff(previous, recommended);
  const minor =
    impact === "minor" || (impact === "major" && semver.major(previous) === 0);
  const version = minor
    ? `${semver.major(previous)}.${semver.minor(previous) + (component === "vscode" ? 2 : 1)}.0`
    : recommended;
  assert.ok(semver.valid(version));
  return version;
}

export function readReleaseVersions(
  sourceSha,
  path = "reports/release/plan.json",
) {
  const plan = JSON.parse(readFileSync(path, "utf8"));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(plan.sourceSha, sourceSha, "Release plan checkout mismatch");
  return Object.fromEntries(
    ["implementation", "studio", "extension", "npmChannel", "extensionChannel"]
      .filter((key) => plan[key] !== undefined)
      .map((key) => [key, plan[key]]),
  );
}

export function generateReleasePlan(cwd = process.cwd()) {
  const sourceSha = git(cwd, "rev-parse", "HEAD");
  if (process.env.TINTA_RELEASE_SOURCE_SHA)
    assert.equal(sourceSha, process.env.TINTA_RELEASE_SOURCE_SHA);
  const latest = (pattern) =>
    git(
      cwd,
      "tag",
      "--merged=HEAD",
      "--list",
      pattern,
      "--sort=-version:refname",
    ).split("\n")[0];
  const legacy = latest("tinta-v*-vscode-*-stable");
  const match = /^tinta-v(\d+\.\d+\.\d+)-vscode-(\d+\.\d+\.\d+)-stable$/.exec(
    legacy,
  );
  const fallback = match && {
    language: match[1],
    studio: match[1],
    vscode: match[2],
  };
  const cli = fileURLToPath(
    new URL(
      "bin/release-it.js",
      import.meta.resolve("release-it/package.json"),
    ),
  );
  const plugin = fileURLToPath(
    import.meta.resolve("@release-it/conventional-changelog"),
  );
  const config = JSON.parse(
    readFileSync(new URL("../toolchain/release-it.json", import.meta.url)),
  );
  const directory = join(cwd, "reports/release");
  mkdirSync(directory, { recursive: true });
  const tools = {};
  const plans = {};
  for (const component of names) {
    const { tagPrefix } = releaseComponents[component];
    const tag = latest(`${tagPrefix}*`);
    assert.ok(tag || fallback, `No published baseline for ${component}`);
    const previous = tag ? tag.slice(tagPrefix.length) : fallback[component];
    assert.ok(semver.valid(previous));
    const before = git(cwd, "rev-parse", `${tag || legacy}^{commit}`);
    const input = join(directory, component);
    mkdirSync(input, { recursive: true });
    writeFileSync(
      join(input, "package.json"),
      JSON.stringify({
        name: `tinta-${component}-release-input`,
        private: true,
        version: previous,
      }),
    );
    const settings = structuredClone(config);
    settings.git.tagMatch = tag ? `${tagPrefix}*` : legacy;
    const commits = { from: before, path: pathspec(component) };
    const options = settings.plugins["@release-it/conventional-changelog"];
    settings.plugins = {
      [plugin]: {
        ...options,
        commitsOpts: commits,
        gitRawCommitsOpts: commits,
      },
    };
    const settingsPath = join(input, "release-it.json");
    writeFileSync(settingsPath, JSON.stringify(settings));
    const tool = (...args) =>
      run(input, [
        process.execPath,
        cli,
        "--config",
        settingsPath,
        "--ci",
        "--quiet",
        ...args,
      ]);
    tools[component] = tool;
    const recommended = tool("--release-version");
    plans[component] = {
      previous,
      before,
      changed: affectedComponents(before, sourceSha, cwd).includes(component),
      publish: Boolean(recommended),
      version: recommended
        ? nextComponentVersion(component, previous, recommended)
        : previous,
    };
  }
  // Unreleased language code cannot be embedded under an old public version.
  if (plans.language.changed && names.some((name) => plans[name].publish)) {
    for (const component of names) {
      const plan = plans[component];
      if (!plan.publish) plan.version = semver.inc(plan.previous, "patch");
      plan.publish = true;
    }
  }
  for (const component of names) {
    const plan = plans[component];
    plan.tag = `${releaseComponents[component].tagPrefix}${plan.version}`;
    plan.notes = plan.publish
      ? tools[component](plan.version, "--changelog")
      : "No release changes.";
    writeFileSync(join(directory, `notes-${component}.md`), plan.notes + "\n");
  }
  const selected = names.filter((component) => plans[component].publish);
  const plan = {
    sourceSha,
    publish: selected.length > 0,
    implementation: plans.language.version,
    studio: plans.studio.version,
    extension: plans.vscode.version,
    npmChannel: "latest",
    extensionChannel: "stable",
    components: plans,
    matrix: { component: selected },
  };
  writeFileSync(
    join(directory, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === "--affected") {
    const selected = affectedComponents(process.argv[3], process.argv[4]);
    if (process.argv.includes("--pending")) {
      assert.equal(git(process.cwd(), "rev-parse", "HEAD"), process.argv[4]);
      selected.push(...generateReleasePlan().matrix.component);
    }
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        names.map((name) => `${name}=${selected.includes(name)}\n`).join(""),
      );
    else
      console.log(
        JSON.stringify(names.filter((name) => selected.includes(name))),
      );
  } else {
    const plan = generateReleasePlan();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `publish=${plan.publish}\nmatrix=${JSON.stringify(plan.matrix)}\n` +
          `host_publish=${plan.matrix.component.some((name) => name !== "language")}\n` +
          `hosts=${JSON.stringify({ component: plan.matrix.component.filter((name) => name !== "language") })}\n` +
          names
            .map((name) => `${name}=${plan.components[name].publish}\n`)
            .join(""),
      );
  }
}
