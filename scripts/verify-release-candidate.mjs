import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadReleaseConfig } from "./release-contract.mjs";
import { requireCommandSync } from "./commands.mjs";
import {
  readCandidateJson,
  checkFile,
  checkInventory,
  assembleManifest,
  verifyProducer,
} from "./release-candidate.mjs";

export function verifyCandidateFiles(directory, config = loadReleaseConfig()) {
  const index = readCandidateJson(
    readFileSync(join(directory, "candidate-index.json")),
  );
  assert.deepEqual(
    Object.keys(index).sort(),
    [
      "format",
      "producer",
      "createdAt",
      "expiresAt",
      "retentionDays",
      "storage",
      "manifest",
      "inventory",
      "reports",
    ].sort(),
    "Closed candidate index",
  );
  assert.equal(index.manifest.path, "release-manifest.json");
  assert.equal(index.inventory.path, "inventory.json");
  const manifest = readCandidateJson(checkFile(directory, index.manifest));
  checkFile(directory, index.inventory);
  assert.equal(
    readFileSync(join(directory, "release-manifest.json.sha256"), "utf8"),
    index.manifest.sha256 + "\n",
  );
  assert.deepEqual(Object.keys(index.reports).sort(), [
    "build",
    "darwin-arm64",
    "linux-arm64",
    "win32-x64",
  ]);
  const reports = Object.fromEntries(
    Object.entries(index.reports).map(([key, record]) => {
      assert.equal(record.path, `${key}.json`);
      return [key, readCandidateJson(checkFile(directory, record))];
    }),
  );
  assert.equal(reports.build.inventorySha256, index.inventory.sha256);
  const inventory = checkInventory(directory, config, { clean: true });
  const expected = assembleManifest(
    config,
    inventory,
    index.producer,
    reports.build,
    [reports["darwin-arm64"], reports["linux-arm64"], reports["win32-x64"]],
    index.reports,
  );
  assert.deepEqual(manifest, expected, "Manifest does not match tested files");
  assert.deepEqual(
    index.storage.map((s) => s.name).sort(),
    [
      "payloads",
      "results-darwin-arm64",
      "results-linux-arm64",
      "results-win32-x64",
    ]
      .map(
        (name) => `${name}-${index.producer.runId}-${index.producer.attempt}`,
      )
      .sort(),
  );
  assert.equal(new Set(index.storage.map((s) => s.id)).size, 4);
  return index;
}

export function verifyAttestation(
  path,
  producer,
  execute = requireCommandSync,
) {
  assert.match(execute(["gh", "--version"]).stdout, /^gh version 2\.102\.0 /);
  const result = execute([
    "gh",
    "attestation",
    "verify",
    path,
    "--repo",
    producer.repository,
    "--signer-workflow",
    `${producer.repository}/${producer.workflow}`,
    "--signer-digest",
    producer.workflowSha,
    "--source-digest",
    producer.sourceSha,
    "--source-ref",
    producer.ref,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--format",
    "json",
  ]);
  const verified = readCandidateJson(Buffer.from(result.stdout));
  assert.ok(
    Array.isArray(verified) && verified.length > 0,
    "No verified attestation",
  );
  const invocation = `https://github.com/${producer.repository}/actions/runs/${producer.runId}/attempts/${producer.attempt}`;
  assert.ok(
    verified.some(
      (entry) =>
        entry.verificationResult?.statement?.predicate?.runDetails?.metadata
          ?.invocationId === invocation,
    ),
    "Attestation from another run or attempt",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, expectedFile] = process.argv.slice(2);
  assert.ok(
    directory && expectedFile,
    "Pass candidate directory and independently reviewed producer/artifact identity JSON",
  );
  const expected = readCandidateJson(readFileSync(expectedFile));
  const index = verifyCandidateFiles(directory);
  await verifyProducer(
    index,
    { ...expected, indexPath: join(directory, "candidate-index.json") },
    {
      now: Date.now(),
      api: async (path) =>
        readCandidateJson(
          Buffer.from(requireCommandSync(["gh", "api", path]).stdout),
        ),
      attest: verifyAttestation,
    },
  );
  console.log(
    "Candidate payloads, required results, successful producer, retention and signature verified. No publication performed.",
  );
}
