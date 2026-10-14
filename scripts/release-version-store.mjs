import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  nextVersions,
  releaseImpact,
  releaseNotes,
  releaseSource,
  validateReleasePlan,
  versionBranch,
} from "./automatic-release.mjs";
import { httpTransport, githubApi } from "./publication-transport.mjs";

const format = "tinta-release-versions-1";
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();

export function commitsSince(before, sourceSha, execute = git) {
  assert.match(before, /^[a-f0-9]{40}$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  return execute(
    "log",
    "--reverse",
    "--format=%H%x00%B%x00",
    `${before}..${sourceSha}`,
  )
    .split("\0\n")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\0");
      const sha = record.slice(0, separator).trim();
      const message = record.slice(separator + 1).trim();
      assert.match(sha, /^[a-f0-9]{40}$/);
      return { sha, message, subject: message.split("\n", 1)[0] };
    });
}

export function planRelease({
  baseline,
  store,
  journal,
  sourceSha,
  repository,
  execute = git,
}) {
  assert.equal(baseline.schemaVersion, 1);
  assert.match(baseline.baseCommit, /^[a-f0-9]{40}$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(
    execute("rev-parse", "HEAD"),
    sourceSha,
    "Release checkout mismatch",
  );
  const history = execute("rev-list", "--first-parent", sourceSha).split("\n");
  assert.ok(
    history.includes(baseline.baseCommit),
    "Release baseline is outside first-parent history",
  );
  if (store !== null) {
    assert.equal(store.format, format);
    assert.deepEqual(
      store.baseline,
      baseline,
      "Version policy requires an explicit migration",
    );
    if (store.plans[sourceSha]) {
      return {
        plan: validateReleasePlan(store.plans[sourceSha], sourceSha),
        next: null,
      };
    }
  }
  const previous = store?.latest ?? {
    sourceSha: baseline.baseCommit,
    implementation: baseline.implementation,
    extension: baseline.extension,
  };
  assert.ok(
    history.includes(previous.sourceSha),
    "Version reservations cannot move backwards or across branches",
  );
  let before = baseline.baseCommit;
  assert.equal(journal.format, "tinta-publication-store-1");
  for (const record of Object.values(journal.releases)) {
    if (record.status !== "promoted") continue;
    const published = record.items["github:tag"]?.receipt?.sourceSha;
    const position = history.indexOf(published);
    if (position >= 0 && position < history.indexOf(before)) before = published;
  }
  const commits = commitsSince(before, sourceSha, execute);
  const impact = releaseImpact(commits);
  const incremental = releaseImpact(
    commitsSince(previous.sourceSha, sourceSha, execute),
  );
  const versions = nextVersions(
    { schemaVersion: 1, ...previous },
    impact === null ? null : (incremental ?? "patch"),
  );
  const plan = validateReleasePlan(
    {
      schemaVersion: 1,
      sourceSha,
      before,
      publish: impact !== null,
      impact,
      ...versions,
      notes: releaseNotes(commits, repository),
    },
    sourceSha,
  );
  const next = structuredClone(
    store ?? { format, baseline, latest: previous, plans: {} },
  );
  next.plans[sourceSha] = plan;
  if (plan.publish) next.latest = { sourceSha, ...versions };
  return { plan, next };
}

async function readBranchFile(api, repository, branch, name) {
  const base = `/repos/${repository}`;
  const ref = await api("GET", `${base}/git/ref/heads/${branch}`);
  if (ref === null) return { head: null, value: null };
  const head = ref.object.sha;
  assert.match(head, /^[a-f0-9]{40}$/);
  const commit = await api("GET", `${base}/git/commits/${head}`);
  const tree = await api("GET", `${base}/git/trees/${commit.tree.sha}`);
  assert.equal(tree.truncated, false);
  assert.equal(tree.tree.length, 1);
  assert.equal(tree.tree[0].path, name);
  assert.equal(tree.tree[0].type, "blob");
  const blob = await api("GET", `${base}/git/blobs/${tree.tree[0].sha}`);
  assert.equal(blob.encoding, "base64");
  return {
    head,
    value: JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")),
  };
}

export async function readVersionStore(api, repository) {
  const { head, value } = await readBranchFile(
    api,
    repository,
    versionBranch,
    "versions.json",
  );
  return { head, store: value };
}

export async function reserveRelease({
  api,
  repository,
  baseline,
  sourceSha,
  execute = git,
}) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const base = `/repos/${repository}`;
  const { head, store } = await readVersionStore(api, repository);
  if (store?.plans[sourceSha]) {
    return planRelease({
      baseline,
      store,
      journal: null,
      sourceSha,
      repository,
      execute,
    }).plan;
  }
  const { value: journal } = await readBranchFile(
    api,
    repository,
    "publication-journal",
    "journal.json",
  );
  assert.ok(journal, "Missing publication history");
  const { plan, next } = planRelease({
    baseline,
    store,
    journal,
    sourceSha,
    repository,
    execute,
  });
  if (next === null) return plan;
  const blob = await api("POST", `${base}/git/blobs`, {
    content: encode(next),
    encoding: "utf-8",
  });
  const tree = await api("POST", `${base}/git/trees`, {
    tree: [
      { path: "versions.json", mode: "100644", type: "blob", sha: blob.sha },
    ],
  });
  const commit = await api("POST", `${base}/git/commits`, {
    message: "Record immutable release versions",
    tree: tree.sha,
    parents: head ? [head] : [],
  });
  try {
    if (head) {
      await api("PATCH", `${base}/git/refs/heads/${versionBranch}`, {
        sha: commit.sha,
        force: false,
      });
    } else {
      await api("POST", `${base}/git/refs`, {
        ref: `refs/heads/${versionBranch}`,
        sha: commit.sha,
      });
    }
  } catch {
    const observed = await api("GET", `${base}/git/ref/heads/${versionBranch}`);
    assert.equal(
      observed?.object.sha,
      commit.sha,
      "Version reservation conflict or unknown write",
    );
  }
  return plan;
}

async function main(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const sourceSha = releaseSource(env, event);
  assert.equal(env.GITHUB_REPOSITORY, "planta7/tinta");
  const plan = await reserveRelease({
    api: githubApi(httpTransport(), env.GITHUB_TOKEN),
    repository: env.GITHUB_REPOSITORY,
    baseline: JSON.parse(
      readFileSync("toolchain/automatic-release.json", "utf8"),
    ),
    sourceSha,
  });
  mkdirSync("reports/release", { recursive: true });
  writeFileSync("reports/release/plan.json", encode(plan));
  appendFileSync(env.GITHUB_OUTPUT, `publish=${plan.publish}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === "check") {
    const source = git("rev-parse", "HEAD");
    const before = git("merge-base", "origin/main", source);
    const impact = releaseImpact(commitsSince(before, source));
    console.log(`Commit messages: PASS; release impact: ${impact ?? "none"}`);
  } else {
    assert.equal(process.argv.length, 2, "Unknown version operation");
    await main(process.env);
  }
}
