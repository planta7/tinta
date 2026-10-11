import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireCommandSync } from "./commands.mjs";
import { readCandidateJson } from "./release-candidate.mjs";
import { readZip, safePath, digest } from "./distribution-archive.mjs";
import {
  dispatchInputs,
  activationPolicy,
  publicationGate,
} from "./publication-gate.mjs";
import { loadReleaseConfig } from "./release-contract.mjs";
import {
  httpTransport,
  githubApi,
  entraCredential,
} from "./publication-transport.mjs";
import { githubJournal, encode } from "./publication-journal.mjs";
import { npmAdapter, npmRunner } from "./publication-npm.mjs";
import { marketplaceAdapter } from "./publication-marketplace.mjs";
import { releaseAdapter } from "./publication-github.mjs";
import { publishRelease } from "./publication.mjs";
import { verifyPublishingTool } from "./publication-tools.mjs";

export async function acquireCandidate(api, inputs, repository, download) {
  const base = `/repos/${repository}`;
  const repo = await api("GET", base);
  const run = await api(
    "GET",
    `${base}/actions/runs/${inputs.run}/attempts/${inputs.attempt}`,
  );
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.path, ".github/workflows/release-candidate.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.repository.full_name, repository);
  const source = await api("GET", `${base}/git/commits/${run.head_sha}`);
  const list = await api(
    "GET",
    `${base}/actions/runs/${inputs.run}/artifacts?per_page=100`,
  );
  assert.ok(
    list.total_count <= 100,
    "Candidate artifact listing requires reconciliation",
  );
  const name = `candidate-${inputs.run}-${inputs.attempt}`;
  const matches = list.artifacts.filter((item) => item.name === name);
  assert.equal(matches.length, 1, "Missing or ambiguous candidate artifact");
  const artifact = matches[0];
  assert.equal(artifact.expired, false);
  const bytes = await download(`${base}/actions/artifacts/${artifact.id}/zip`);
  assert.equal(
    `sha256:${digest(bytes)}`,
    artifact.digest,
    "Candidate container digest mismatch",
  );
  return {
    bytes,
    expected: {
      producer: {
        repository,
        repositoryId: String(repo.id),
        workflow: run.path,
        workflowSha: run.head_sha,
        sourceSha: run.head_sha,
        sourceTree: source.tree.sha,
        event: run.event,
        runId: String(run.id),
        attempt: run.run_attempt,
        ref: `refs/heads/${repo.default_branch}`,
      },
      candidateArtifact: { id: artifact.id, name, digest: artifact.digest },
    },
  };
}

async function main(mode, env) {
  const inputs = dispatchInputs(env);
  const policy = readCandidateJson(readFileSync("toolchain/publication.json"));
  activationPolicy(policy, loadReleaseConfig(), env);
  const request = httpTransport();
  const api = githubApi(request, env.GITHUB_TOKEN);
  const directory = "build/publication/candidate";
  if (mode === "prepare") {
    const { bytes, expected } = await acquireCandidate(
      api,
      inputs,
      policy.repository,
      async (path) =>
        requireCommandSync(["gh", "api", path], {
          encoding: "buffer",
          env: { ...env, GH_TOKEN: env.GITHUB_TOKEN },
        }).stdout,
    );
    mkdirSync(directory, { recursive: true });
    for (const [path, content] of Object.entries(readZip(bytes))) {
      safePath(path);
      assert.ok(!path.includes("/"), "Candidate files must be flat");
      writeFileSync(join(directory, path), content);
    }
    writeFileSync("build/publication/expected.json", encode(expected));
    await publicationGate({
      directory,
      expected,
      inputs,
      policy,
      env,
      api: (path) => api("GET", path),
    });
    const npmBytes = await request(policy.npm.url, { binary: true });
    assert.equal(
      `sha512-${createHash("sha512").update(npmBytes).digest("base64")}`,
      policy.npm.integrity,
    );
    mkdirSync("build/publication/npm");
    writeFileSync("build/publication/npm.tgz", npmBytes);
    requireCommandSync([
      "tar",
      "-xzf",
      "build/publication/npm.tgz",
      "--strip-components=1",
      "-C",
      "build/publication/npm",
    ]);
    verifyPublishingTool(
      "build/publication/npm",
      policy.npm,
      readCandidateJson(readFileSync("toolchain/publication-npm-lock.json")),
    );
    npmRunner("build/publication/npm/bin/npm-cli.js");
    // Only reviewed code/dependencies are transferred; no candidate source is executed.
    const paths = [
      "node_modules",
      ...loadReleaseConfig().packages.map((p) => `${p.source}/node_modules`),
    ];
    const { existsSync } = await import("node:fs");
    requireCommandSync([
      "tar",
      "-czf",
      "build/publication/dependencies.tgz",
      ...paths.filter(existsSync),
    ]);
    const transportHash = digest(
      readFileSync("build/publication/dependencies.tgz"),
    );
    appendFileSync(env.GITHUB_OUTPUT, `dependencies_sha256=${transportHash}\n`);
    return;
  }
  assert.ok(["npm", "marketplace", "promote", "github"].includes(mode));
  assert.equal(
    digest(readFileSync("build/publication/dependencies.tgz")),
    env.TINTA_DEPENDENCIES_SHA256,
  );
  const expected = readCandidateJson(
    readFileSync("build/publication/expected.json"),
  );
  let verified;
  const gate = async () => {
    verified = await publicationGate({
      directory,
      expected,
      inputs,
      policy,
      env,
      api: (path) => api("GET", path),
    });
    return verified.plan;
  };
  await gate();
  const npmBytes = readFileSync("build/publication/npm.tgz");
  assert.equal(
    `sha512-${createHash("sha512").update(npmBytes).digest("base64")}`,
    policy.npm.integrity,
  );
  mkdirSync("build/publication/npm", { recursive: true });
  requireCommandSync([
    "tar",
    "-xzf",
    "build/publication/npm.tgz",
    "--strip-components=1",
    "-C",
    "build/publication/npm",
  ]);
  verifyPublishingTool(
    "build/publication/npm",
    policy.npm,
    readCandidateJson(readFileSync("toolchain/publication-npm-lock.json")),
  );
  const adapters = {
    npm: npmAdapter({
      request,
      runner: npmRunner("build/publication/npm/bin/npm-cli.js"),
      directory,
    }),
    marketplace: marketplaceAdapter({
      request,
      credential: () => entraCredential(request, env, policy.marketplace),
      directory,
      publisherId: policy.marketplace.publisherId,
    }),
    github: releaseAdapter({
      api,
      request,
      token: env.GITHUB_TOKEN,
      directory,
    }),
  };
  const journal = githubJournal(
    api,
    policy.repository,
    `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}`,
  );
  const result = await publishRelease({
    gate,
    journal,
    adapters,
    intent: verified.intent,
    now: Date.now,
    phase: mode,
  });
  writeFileSync("build/publication/receipt.json", encode(result));
  console.log(
    mode === "github"
      ? "All required destinations verified and promoted."
      : "Destination verified; coordinated release remains incomplete.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv[2], process.env).catch(() => {
    console.error(
      "Publication stopped. Consult the durable journal; do not repeat unknown writes.",
    );
    process.exitCode = 1;
  });
}
