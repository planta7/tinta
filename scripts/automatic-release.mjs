import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function nextVersions(baseline, distance) {
  assert.equal(baseline.schemaVersion, 1);
  assert.ok(Number.isSafeInteger(distance) && distance > 0);
  const increment = (value) => {
    assert.match(value, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = value.split(".").map(Number);
    assert.ok(Number.isSafeInteger(patch + distance));
    return `${major}.${minor}.${patch + distance}`;
  };
  assert.equal(Number(baseline.extension.split(".")[1]) % 2, 0);
  return {
    implementation: increment(baseline.implementation),
    extension: increment(baseline.extension),
    npmChannel: "latest",
    extensionChannel: "stable",
  };
}

export function automaticVersions(
  sourceSha,
  {
    baseline = JSON.parse(
      readFileSync(
        new URL("../toolchain/automatic-release.json", import.meta.url),
      ),
    ),
    execute = git,
  } = {},
) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(
    execute("rev-parse", "HEAD"),
    sourceSha,
    "Release checkout mismatch",
  );
  assert.match(baseline.baseCommit, /^[a-f0-9]{40}$/);
  const history = execute("rev-list", "--first-parent", sourceSha).split("\n");
  const distance = history.indexOf(baseline.baseCommit);
  assert.ok(
    distance > 0,
    "Release baseline must precede source on first-parent history",
  );
  return nextVersions(baseline, distance);
}

export function releaseNotes(commits, repository) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(commits.length > 0, "Empty release changes");
  return (
    "Changes in this push:\n\n" +
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

export function prepareAutomaticRelease(env = process.env) {
  assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(event.repository.full_name, env.GITHUB_REPOSITORY);
  assert.equal(event.repository.default_branch, "main");
  assert.equal(event.after, env.GITHUB_SHA);
  assert.equal(event.forced, false, "Force pushes cannot produce releases");
  assert.match(event.before, /^[a-f0-9]{40}$/);
  const baseline = JSON.parse(readFileSync("toolchain/automatic-release.json"));
  const before = /^0+$/.test(event.before) ? baseline.baseCommit : event.before;
  git("merge-base", "--is-ancestor", before, event.after);
  const commits = git(
    "log",
    "--reverse",
    "--format=%H%x09%s",
    `${before}..${event.after}`,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      return {
        sha: line.slice(0, separator),
        subject: line.slice(separator + 1),
      };
    });
  const plan = {
    schemaVersion: 1,
    sourceSha: event.after,
    before,
    ...automaticVersions(event.after),
    notes: releaseNotes(commits, env.GITHUB_REPOSITORY),
  };
  mkdirSync("reports/release", { recursive: true });
  writeFileSync(
    "reports/release/plan.json",
    JSON.stringify(plan, null, 2) + "\n",
  );
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  prepareAutomaticRelease();
}
