import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const versionBranch = "release-versions";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();

function versionParts(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const parts = value.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Unsafe version number");
  return parts;
}

export function commitImpact({ message }) {
  assert.equal(typeof message, "string");
  const header = message.split(/\r?\n/, 1)[0];
  if (/^Merge /.test(header)) return null;
  const parsed = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?: .+$/i.exec(header);
  assert.ok(parsed, "Release commits must follow Conventional Commits");
  if (parsed[2] || /^BREAKING[ -]CHANGE: .+/m.test(message)) return "breaking";
  const type = parsed[1].toLowerCase();
  if (type === "feat") return "minor";
  return ["fix", "perf", "revert"].includes(type) ? "patch" : null;
}

export function releaseImpact(commits) {
  const impacts = commits.map(commitImpact);
  return (
    ["breaking", "minor", "patch"].find((level) => impacts.includes(level)) ??
    null
  );
}

function increment(value, impact, { extension = false } = {}) {
  let [major, minor, patch] = versionParts(value);
  if (extension)
    assert.equal(minor % 2, 0, "Stable extension minor must be even");
  if (impact === "breaking" && major > 0) {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (impact === "minor" || impact === "breaking") {
    minor += extension ? 2 : 1;
    patch = 0;
  } else if (impact === "patch") {
    patch += 1;
  } else {
    assert.equal(impact, null);
  }
  assert.ok([major, minor, patch].every(Number.isSafeInteger));
  return `${major}.${minor}.${patch}`;
}

export function nextVersions(baseline, impact) {
  assert.equal(baseline.schemaVersion, 1);
  return {
    implementation: increment(baseline.implementation, impact),
    extension: increment(baseline.extension, impact, { extension: true }),
    npmChannel: "latest",
    extensionChannel: "stable",
  };
}

export function validateReleasePlan(plan, sourceSha) {
  assert.equal(plan.schemaVersion, 1);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(plan.sourceSha, sourceSha, "Release plan checkout mismatch");
  assert.match(plan.before, /^[a-f0-9]{40}$/);
  assert.equal(typeof plan.publish, "boolean");
  assert.ok([null, "patch", "minor", "breaking"].includes(plan.impact));
  assert.equal(plan.publish, plan.impact !== null);
  versionParts(plan.implementation);
  assert.equal(versionParts(plan.extension)[1] % 2, 0);
  assert.equal(plan.npmChannel, "latest");
  assert.equal(plan.extensionChannel, "stable");
  assert.equal(typeof plan.notes, "string");
  assert.ok(plan.notes.trim());
  return plan;
}

export function storedReleasePlan(
  sourceSha,
  {
    execute = git,
    readPlan = () =>
      existsSync("reports/release/plan.json")
        ? JSON.parse(readFileSync("reports/release/plan.json", "utf8"))
        : null,
  } = {},
) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(
    execute("rev-parse", "HEAD"),
    sourceSha,
    "Release checkout mismatch",
  );
  let plan = readPlan();
  if (plan === null) {
    const store = JSON.parse(
      execute("show", `refs/remotes/origin/${versionBranch}:versions.json`),
    );
    assert.equal(store.format, "tinta-release-versions-1");
    plan = store.plans[sourceSha];
  }
  validateReleasePlan(plan, sourceSha);
  const history = execute("rev-list", "--first-parent", sourceSha).split("\n");
  assert.ok(
    history.includes(plan.before),
    "Release baseline is outside first-parent history",
  );
  return plan;
}

export function automaticVersions(sourceSha, options) {
  const plan = storedReleasePlan(sourceSha, options);
  return {
    implementation: plan.implementation,
    extension: plan.extension,
    npmChannel: plan.npmChannel,
    extensionChannel: plan.extensionChannel,
  };
}

export function releaseNotes(commits, repository) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(commits.length > 0, "Empty release changes");
  return (
    "Changes since the previous complete release:\n\n" +
    commits
      .map(({ sha, subject }) => {
        assert.match(sha, /^[a-f0-9]{40}$/);
        const text = [...subject]
          .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
          .join("")
          .replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&");
        return `- ${text} ([${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}))`;
      })
      .join("\n")
  );
}

export function releaseSource(env, event) {
  assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(event.repository.full_name, env.GITHUB_REPOSITORY);
  assert.equal(event.repository.default_branch, "main");
  assert.equal(event.after, env.GITHUB_SHA);
  assert.equal(event.forced, false, "Force pushes cannot produce releases");
  assert.match(event.before, /^[a-f0-9]{40}$/);
  assert.match(event.after, /^[a-f0-9]{40}$/);
  return event.after;
}

export function prepareAutomaticRelease(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "push") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    releaseSource(env, event);
    git("merge-base", "--is-ancestor", event.before, event.after);
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_run");
  }
  const plan = storedReleasePlan(env.TINTA_RELEASE_SOURCE_SHA);
  mkdirSync("reports/release", { recursive: true });
  writeFileSync(
    "reports/release/plan.json",
    JSON.stringify(plan, null, 2) + "\n",
  );
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `publish=${plan.publish}\n`);
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  prepareAutomaticRelease();
}
