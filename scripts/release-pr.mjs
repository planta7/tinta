import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareCheckout,
  readRequest,
  releasePaths,
} from "./prepare-release.mjs";
import { sha256 } from "./release-contract.mjs";

const branch = "codex/prepare-release";
const blobHash = (content) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** The transport is injected so integration tests have no network or credentials. */
export async function createReleasePr(
  api,
  { repository, base, source, authorized, plan },
) {
  requireValue(authorized === true, "Remote preparation is not authorized");
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid repository");
  requireValue(/^[a-f0-9]{40}$/.test(source), "Invalid source commit");
  requireValue(
    typeof base === "string" && base.length > 0,
    "Missing base branch",
  );
  requireValue(
    Object.keys(plan.files).length > 0 &&
      Object.keys(plan.files).every((path) => releasePaths.includes(path)),
    "Unexpected release paths",
  );
  const prefix = `/repos/${repository}`;
  const call = (method, path, body) => api(method, prefix + path, body);
  const repo = await call("GET", "");
  requireValue(
    repo.default_branch === base,
    "Only the default branch can prepare releases",
  );
  const ref = await call("GET", `/git/ref/heads/${encodeURIComponent(base)}`);
  requireValue(
    ref.object.sha === source,
    "Default branch moved; review a new request",
  );
  const message = `chore(release): prepare versions\n\nPreparation: ${sha256(JSON.stringify({ source, plan }))}`;
  const title = "chore(release): prepare coordinated versions";
  const body = [
    `Version decision: ${plan.decision}`,
    "",
    "Updates the implementation and extension inputs and user-visible changelog.",
    "Source manifests and the workspace lock remain unchanged; generated npm manifests use these exact internal edges:",
    "",
    "```json",
    JSON.stringify(plan.dependencies, null, 2),
    "```",
    "",
    "Checks triggered with GITHUB_TOKEN may await maintainer approval. Approve and require the verification checks before merging.",
    "This request does not merge, tag, publish, or establish installed-platform compatibility.",
  ].join("\n");
  const prs = await call(
    "GET",
    `/pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
  );
  requireValue(
    prs.length <= 1,
    "Ambiguous release PR history; manual reconciliation required",
  );
  const existingPr = prs[0];
  if (existingPr) {
    requireValue(
      existingPr.state === "open" &&
        existingPr.base.ref === base &&
        existingPr.head.repo.full_name === repository &&
        existingPr.title === title &&
        existingPr.body === body,
      "Existing PR contains unrelated or completed work",
    );
  }
  const existing = await call("GET", `/git/ref/heads/${branch}`);
  if (existing) {
    const comparison = await call(
      "GET",
      `/compare/${source}...${existing.object.sha}`,
    );
    requireValue(
      comparison.status === "ahead" &&
        comparison.total_commits === 1 &&
        comparison.commits.length === 1 &&
        comparison.commits[0].commit.message === message &&
        comparison.files.length === Object.keys(plan.files).length &&
        comparison.files.every(
          (file) =>
            Object.hasOwn(plan.files, file.filename) &&
            file.status === "modified" &&
            file.sha === blobHash(plan.files[file.filename]),
        ),
      "Release branch contains unrelated work; refusing to rewrite it",
    );
  } else {
    requireValue(!existingPr, "PR branch is missing");
    const parent = await call("GET", `/git/commits/${source}`);
    const tree = await call("POST", "/git/trees", {
      base_tree: parent.tree.sha,
      tree: Object.keys(plan.files).map((path) => ({
        path,
        mode: "100644",
        type: "blob",
        content: plan.files[path],
      })),
    });
    const identity = {
      name: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
      date: parent.committer.date,
    };
    const commit = await call("POST", "/git/commits", {
      message,
      tree: tree.sha,
      parents: [source],
      author: identity,
      committer: identity,
    });
    // Creating a missing ref is atomic; a competing branch is never force-updated.
    await call("POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  }
  return (
    existingPr ??
    (await call("POST", "/pulls", { title, body, head: branch, base }))
  );
}

export function githubTransport(token, fetcher = fetch) {
  requireValue(
    typeof token === "string" && token.length > 0,
    "Missing workflow token",
  );
  return async (method, path, body) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      response.status === 404 &&
      method === "GET" &&
      path.endsWith(`/git/ref/heads/${branch}`)
    )
      return null;
    requireValue(
      response.ok,
      `GitHub API ${method} failed (${response.status})`,
    );
    return response.json();
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  requireValue(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      process.env.GITHUB_REF ===
        `refs/heads/${event.repository.default_branch}` &&
      event.inputs.authorize_remote === "true",
    "Explicit default-branch dispatch required",
  );
  const plan = prepareCheckout(readRequest(event.inputs.request));
  const pr = await createReleasePr(githubTransport(process.env.GITHUB_TOKEN), {
    repository: process.env.GITHUB_REPOSITORY,
    base: event.repository.default_branch,
    source: process.env.GITHUB_SHA,
    authorized: true,
    plan,
  });
  console.log(`Release pull request: ${pr.html_url}`);
}
