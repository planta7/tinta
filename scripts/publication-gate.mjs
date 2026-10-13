import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReleaseConfig } from "./release-contract.mjs";
import {
  verifyCandidateFiles,
  verifyAttestation,
} from "./verify-release-candidate.mjs";
import {
  readCandidateJson,
  verifyProducer,
  fileRecord,
} from "./release-candidate.mjs";
import { readTarball } from "./distribution-archive.mjs";
import { validateIntent } from "./publication.mjs";
import { publishingNpmVersion } from "./publication-npm.mjs";

export function dispatchInputs(
  env,
  event = readCandidateJson(readFileSync(env.GITHUB_EVENT_PATH)),
) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_run");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  const run = event.workflow_run;
  assert.equal(run.event, "push");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.path, ".github/workflows/verify.yml");
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_repository.full_name, env.GITHUB_REPOSITORY);
  assert.equal(String(run.head_repository.id), env.GITHUB_REPOSITORY_ID);
  assert.equal(String(run.id), env.TINTA_CANDIDATE_RUN);
  assert.equal(String(run.run_attempt), env.TINTA_CANDIDATE_ATTEMPT);
  assert.equal(run.head_sha, env.TINTA_RELEASE_SOURCE_SHA);
  assert.match(env.TINTA_CANDIDATE_RUN, /^[1-9][0-9]*$/);
  assert.match(env.TINTA_CANDIDATE_ATTEMPT, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(Number(env.TINTA_CANDIDATE_ATTEMPT)));
  if (env.TINTA_MANIFEST_SHA256)
    assert.match(env.TINTA_MANIFEST_SHA256, /^[a-f0-9]{64}$/);
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  return {
    run: env.TINTA_CANDIDATE_RUN,
    attempt: Number(env.TINTA_CANDIDATE_ATTEMPT),
    digest: env.TINTA_MANIFEST_SHA256,
    publisherSha: env.TINTA_RELEASE_SOURCE_SHA,
  };
}

export function activationPolicy(policy, config, env) {
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.enabled, true, "External activation is disabled");
  assert.equal(
    config.policy.externalActivation,
    true,
    "Distribution activation is disabled",
  );
  assert.equal(policy.repository, env.GITHUB_REPOSITORY);
  assert.equal(policy.repositoryId, env.GITHUB_REPOSITORY_ID);
  assert.match(env.TINTA_RELEASE_SOURCE_SHA, /^[a-f0-9]{40}$/);
  assert.equal(policy.environment, "release");
  assert.equal(config.identities.repository.value, policy.repository);
  assert.equal(policy.npm.version, publishingNpmVersion);
  for (const key of [
    "publishPermission",
    "distTagPermission",
    "bootstrapComplete",
  ]) {
    assert.equal(policy.npm[key], true, `Missing npm binding: ${key}`);
  }
  assert.equal(
    policy.marketplace.githubFederationVerified,
    true,
    "GitHub-to-Entra federation is unverified",
  );
  assert.match(policy.marketplace.publisherId, /^[a-f0-9-]{36}$/i);
}

export async function publicationGate({
  directory,
  expected,
  inputs,
  policy,
  env,
  api,
  attest = verifyAttestation,
  now = Date.now(),
}) {
  const config = loadReleaseConfig();
  activationPolicy(policy, config, env);
  const index = verifyCandidateFiles(directory, config);
  const inventory = readCandidateJson(
    readFileSync(join(directory, index.inventory.path)),
  );
  assert.equal(
    inventory.releasePlan?.path,
    "release-plan.json",
    "Missing signed release plan",
  );
  assert.equal(index.producer.runId, inputs.run);
  assert.equal(index.producer.attempt, inputs.attempt);
  assert.equal(index.producer.sourceSha, inputs.publisherSha);
  if (inputs.digest)
    assert.equal(
      index.manifest.sha256,
      inputs.digest,
      "Manifest digest mismatch",
    );
  await verifyProducer(
    index,
    { ...expected, indexPath: join(directory, "candidate-index.json") },
    { api, attest, now },
  );
  const manifest = readCandidateJson(
    readFileSync(join(directory, index.manifest.path)),
  );
  for (const target of manifest.targets.filter((t) => t.kind === "npm")) {
    const archive = readTarball(
      readFileSync(join(directory, target.archive.path)),
    );
    const metadata = readCandidateJson(archive["package.json"]);
    assert.deepEqual(
      metadata.publishConfig,
      { access: "public", tag: target.channel },
      "Unexpected publish configuration",
    );
    assert.equal(
      metadata.scripts,
      undefined,
      "Package lifecycle hooks are forbidden",
    );
    assert.equal(
      metadata.repository?.url,
      `https://github.com/${policy.repository}.git`,
      "Tarball repository metadata is not eligible for trusted publishing",
    );
  }
  const plan = {
    candidate: index.manifest.sha256,
    publisherSha: inputs.publisherSha,
    repository: policy.repository,
    releaseId: manifest.releaseId,
    tag: manifest.tag,
    sourceSha: manifest.source.commit,
    expiresAt: index.expiresAt,
    targets: manifest.targets,
    metadata: [
      "release-plan.json",
      "release-manifest.json",
      "release-manifest.json.sha256",
      "candidate-index.json",
      "attestation.sigstore.json",
      index.inventory.path,
      ...Object.values(index.reports).map((record) => record.path),
    ].map((path) => fileRecord(path, readFileSync(join(directory, path)))),
  };
  const intent = {
    candidate: plan.candidate,
    publisherSha: plan.publisherSha,
    releaseId: plan.releaseId,
    expiresAt: plan.expiresAt,
    reconciliation: null,
  };
  validateIntent(intent, plan, now);
  return { plan, intent };
}
