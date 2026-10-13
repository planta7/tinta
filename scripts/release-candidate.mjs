import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { inspectPackage } from "./vscode-package.mjs";
import {
  digest,
  safePath,
  inspectEntries,
  readTarball,
  readZip,
} from "./distribution-archive.mjs";
import {
  releaseIdentity,
  validateReleaseManifest,
} from "./release-contract.mjs";

export const candidateWorkflow = ".github/workflows/verify.yml";
export const retentionDays = 30;
export const matrixCells = ["darwin-arm64", "linux-arm64", "win32-x64"];
export const nativeModes = [
  "workflow",
  "restricted",
  "performance",
  "os-offline",
];
export const buildCommands = [
  ["node", "scripts/distribution-package.mjs", "--built"],
  [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--config",
    "scripts/distribution-vitest.config.js",
  ],
  ["node", "scripts/check-release-artifacts.mjs", "build/distribution"],
];

export const verificationWorkflow = ".github/workflows/verify.yml";
export const verificationJobs = [
  "verify",
  "cli-portability (macos-15)",
  "cli-portability (windows-2022)",
];

export function validateVerification(receipt, producer) {
  assert.ok(receipt, "Missing successful Verify run");
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "attempt",
      "conclusion",
      "event",
      "jobs",
      "ref",
      "repository",
      "repositoryId",
      "runId",
      "sourceSha",
      "status",
      "workflow",
      "workflowId",
      "workflowSha256",
    ].sort(),
    "Closed verification receipt",
  );
  assert.equal(receipt.workflow, verificationWorkflow);
  assert.equal(
    receipt.workflowSha256,
    digest(
      readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url)),
    ),
    "Verification workflow changed",
  );
  assert.equal(receipt.repository, producer.repository);
  assert.equal(receipt.repositoryId, producer.repositoryId);
  assert.equal(receipt.sourceSha, producer.sourceSha, "Verify source mismatch");
  assert.equal(receipt.ref, producer.ref);
  assert.equal(receipt.event, "push");
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.conclusion, "success");
  assert.match(receipt.runId, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(receipt.workflowId) && receipt.workflowId > 0);
  assert.ok(Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0);
  assert.deepEqual(
    receipt.jobs.map((job) => job.name).sort(),
    [...verificationJobs].sort(),
    "Missing or duplicate Verify job",
  );
  assert.equal(
    new Set(receipt.jobs.map((job) => job.id)).size,
    verificationJobs.length,
  );
  for (const job of receipt.jobs) {
    assert.deepEqual(Object.keys(job).sort(), [
      "conclusion",
      "id",
      "name",
      "status",
    ]);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
  }
  return receipt;
}

export async function successfulVerification(producer, { api }) {
  const base = `/repos/${producer.repository}/actions`;
  const workflow = await api(`${base}/workflows/verify.yml`);
  assert.equal(workflow.path, verificationWorkflow);
  assert.ok(Number.isSafeInteger(workflow.id) && workflow.id > 0);
  const branch = producer.ref.slice("refs/heads/".length);
  const query = `event=push&branch=${encodeURIComponent(branch)}&head_sha=${producer.sourceSha}&per_page=100`;
  const listing = await api(`${base}/workflows/${workflow.id}/runs?${query}`);
  assert.ok(
    Number.isSafeInteger(listing.total_count) && listing.total_count <= 100,
    "Verify run pagination limit",
  );
  assert.equal(listing.workflow_runs.length, listing.total_count);
  const matches = listing.workflow_runs
    .filter(
      (run) =>
        run.head_sha === producer.sourceSha &&
        run.head_branch === branch &&
        run.event === "push" &&
        run.workflow_id === workflow.id,
    )
    .sort((a, b) => b.run_number - a.run_number);
  assert.ok(matches.length > 0, "No Verify push run for this commit");
  // The latest attempt must succeed; an earlier success cannot mask a rerun.
  const selected =
    matches.find((run) => String(run.id) === producer.runId) ?? matches[0];
  const run = await api(`${base}/runs/${selected.id}`);
  assert.equal(run.id, selected.id);
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(run.path, verificationWorkflow);
  assert.equal(run.head_sha, producer.sourceSha);
  assert.equal(run.head_branch, branch);
  assert.equal(run.event, "push");
  for (const repository of [run.repository, run.head_repository]) {
    assert.equal(repository.full_name, producer.repository);
    assert.equal(String(repository.id), producer.repositoryId);
  }
  const sameRun = String(run.id) === producer.runId;
  if (!sameRun) {
    assert.equal(run.status, "completed", "Verify has not completed");
    assert.equal(run.conclusion, "success", "Verify did not pass");
  } else {
    assert.equal(
      run.run_attempt,
      producer.attempt,
      "Source job attempt mismatch",
    );
    assert.ok(["in_progress", "completed"].includes(run.status));
    if (run.status === "completed") assert.equal(run.conclusion, "success");
  }
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const response = await api(
    `${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  assert.ok(
    Number.isSafeInteger(response.total_count) && response.total_count <= 100,
    "Verify job pagination limit",
  );
  assert.equal(response.jobs.length, response.total_count);
  const jobs = sameRun
    ? response.jobs.filter((job) => verificationJobs.includes(job.name))
    : response.jobs;
  for (const job of jobs) {
    assert.equal(job.run_id, run.id);
    assert.equal(job.head_sha, producer.sourceSha);
    assert.equal(job.status, "completed", "Incomplete Verify job");
    assert.equal(job.conclusion, "success", "Failed or skipped Verify job");
  }
  const current = await api(`${base}/runs/${run.id}`);
  assert.equal(
    current.run_attempt,
    run.run_attempt,
    "Verify rerun changed during lookup",
  );
  if (!sameRun) {
    assert.equal(current.status, "completed");
    assert.equal(current.conclusion, "success");
  }
  return validateVerification(
    {
      workflow: verificationWorkflow,
      workflowId: workflow.id,
      workflowSha256: digest(
        readFileSync(
          new URL("../.github/workflows/verify.yml", import.meta.url),
        ),
      ),
      repository: producer.repository,
      repositoryId: producer.repositoryId,
      sourceSha: run.head_sha,
      ref: producer.ref,
      event: run.event,
      status: "completed",
      conclusion: "success",
      runId: String(run.id),
      attempt: run.run_attempt,
      jobs: jobs.map(({ id, name, status, conclusion }) => ({
        id,
        name,
        status,
        conclusion,
      })),
    },
    producer,
  );
}

export function readCandidateJson(bytes) {
  assert.ok(bytes.length <= 16 * 1024 * 1024, "Metadata size limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  assert.equal(
    parseDocument(text, { uniqueKeys: true }).errors.length,
    0,
    "Duplicate JSON keys",
  );
  return value;
}

export function fileRecord(path, bytes) {
  safePath(path);
  return {
    path,
    bytes: bytes.length,
    sha256: digest(bytes),
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
}

export function checkFile(directory, record) {
  safePath(record.path);
  const path = join(directory, record.path);
  assert.ok(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "Regular file required",
  );
  const bytes = readFileSync(path);
  assert.deepEqual(
    fileRecord(record.path, bytes),
    record,
    `Changed file: ${record.path}`,
  );
  return bytes;
}

export function checkInventory(directory, config, { clean = false } = {}) {
  const inventory = readCandidateJson(
    readFileSync(join(directory, "inventory.json")),
  );
  assert.deepEqual(inventory.versions, config.versions, "Mixed versions");
  assert.equal(
    inventory.configSha256,
    digest(readFileSync(new URL("../toolchain/release.json", import.meta.url))),
    "Configuration digest",
  );
  assert.equal(
    inventory.lockSha256,
    digest(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url))),
    "Lock digest",
  );
  if (clean) assert.equal(inventory.source.dirty, false, "Dirty source");
  if (inventory.releasePlan) {
    assert.equal(inventory.releasePlan.path, "release-plan.json");
    const bytes = readFileSync(join(directory, "release-plan.json"));
    assert.equal(digest(bytes), inventory.releasePlan.sha256);
    const plan = readCandidateJson(bytes);
    assert.equal(plan.sourceSha, inventory.source.commit);
    assert.equal(plan.implementation, config.versions.implementation);
    assert.equal(plan.extension, config.versions.extension);
    assert.equal(typeof plan.notes, "string");
    assert.ok(plan.notes.trim());
  }
  const expected = [...config.packages, ...config.artifacts];
  assert.deepEqual(
    inventory.targets.map((t) => t.id).sort(),
    expected.map((t) => t.id).sort(),
    "Target inventory",
  );
  const paths = inventory.targets.map((t) => t.archive);
  assert.equal(new Set(paths).size, paths.length, "Duplicate archive path");
  for (const target of inventory.targets) {
    const bytes = checkFile(directory, {
      path: target.archive,
      bytes: target.bytes,
      sha256: target.sha256,
      integrity: target.integrity,
    });
    const entries = target.archive.endsWith(".tgz")
      ? readTarball(bytes)
      : readZip(bytes);
    assert.deepEqual(
      inspectEntries(
        entries,
        target.files.map((f) => f.path),
        {
          source: target.id === "source",
        },
      ),
      target.files,
      "Archive members",
    );
    if (target.id === "vscode") {
      const inspection = inspectPackage(bytes, { release: true });
      assert.equal(inspection.identity.commit, inventory.source.commit);
      assert.equal(inspection.identity.dirty, inventory.source.dirty);
      assert.equal(inspection.identity.sourceSha256, inventory.source.sha256);
    }
    if (target.id === "source") {
      const expectedPaths = readCandidateJson(
        entries["toolchain/distribution-source.json"],
      );
      assert.deepEqual(Object.keys(entries).sort(), expectedPaths);
      const sourceHash = createHash("sha256");
      for (const path of expectedPaths)
        sourceHash.update(path + "\0" + digest(entries[path]) + "\n");
      assert.equal(
        sourceHash.digest("hex"),
        inventory.source.sha256,
        "Source archive identity",
      );
      assert.equal(
        digest(entries["toolchain/release.json"]),
        inventory.configSha256,
      );
      assert.equal(digest(entries["pnpm-lock.yaml"]), inventory.lockSha256);
    }
    const prefix = target.id === "vscode" ? "extension/" : "";
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
      assert.ok(entries[prefix + name]?.length, "Missing notices");
    if (config.packages.some((p) => p.id === target.id)) {
      const manifest = readCandidateJson(entries["package.json"]);
      const definition = config.packages.find((p) => p.id === target.id);
      assert.equal(manifest.name, definition.proposedName);
      assert.equal(manifest.version, config.versions.implementation);
      assert.equal(manifest.private, false);
      assert.equal(manifest.scripts, undefined, "No installation hooks");
      assert.deepEqual(manifest.dependencies, {
        ...definition.externalDependencies,
        ...Object.fromEntries(
          definition.dependencies.map((id) => [
            config.packages.find((p) => p.id === id).proposedName,
            config.versions.implementation,
          ]),
        ),
      });
    }
  }
  return inventory;
}

function sameProducer(actual, expected) {
  assert.deepEqual(actual, expected, "Producer identity mismatch");
}

export function validateProducerIdentity(producer) {
  assert.deepEqual(
    Object.keys(producer).sort(),
    [
      "repository",
      "repositoryId",
      "workflow",
      "workflowSha",
      "sourceSha",
      "sourceTree",
      "event",
      "runId",
      "attempt",
      "ref",
    ].sort(),
    "Closed producer identity",
  );
  assert.match(producer.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  for (const key of ["repositoryId", "runId"])
    assert.match(producer[key], /^[1-9][0-9]*$/);
  for (const key of ["workflowSha", "sourceSha", "sourceTree"])
    assert.match(producer[key], /^[a-f0-9]{40}$/);
  assert.equal(
    producer.workflowSha,
    producer.sourceSha,
    "Workflow and source must be the reviewed default-branch revision",
  );
  assert.equal(producer.workflow, candidateWorkflow);
  assert.equal(producer.event, "push");
  assert.match(producer.ref, /^refs\/heads\/[A-Za-z0-9/_.-]+$/);
  assert.ok(Number.isSafeInteger(producer.attempt) && producer.attempt > 0);
}

export function checkReports(inventory, producer, build, reports) {
  validateProducerIdentity(producer);
  assert.equal(inventory.source.dirty, false, "Dirty source");
  assert.equal(inventory.source.commit, producer.sourceSha, "Wrong source");
  sameProducer(build.producer, producer);
  assert.equal(build.status, "PASS", "Build gates failed");
  validateVerification(build.verification, producer);
  const dependencies = JSON.parse(
    readFileSync(new URL("../toolchain/dependencies.json", import.meta.url)),
  );
  for (const [name, upstream] of Object.entries({
    pnpm: "pnpm",
    typescript: "typescript",
    esbuild: "esbuild",
    playwright: "@playwright/test",
    vite: "vite",
  })) {
    const actual = build.tools.filter((tool) => tool.name === name);
    const pinned = dependencies.find((tool) => tool.name === upstream);
    assert.equal(actual.length, 1, "Missing or duplicate tool");
    assert.equal(actual[0].version, pinned.version, "Tool version mismatch");
    assert.equal(
      actual[0].integrity,
      pinned.dist.integrity,
      "Tool integrity mismatch",
    );
  }
  for (const [name, version] of [
    ["node", "24.21.0"],
    ["npm", "11.19.0"],
  ]) {
    const actual = build.tools.filter((tool) => tool.name === name);
    assert.equal(actual.length, 1, "Missing runtime tool");
    assert.equal(actual[0].version, version);
    assert.match(actual[0].integrity, /^sha256:[a-f0-9]{64}$/);
  }

  assert.deepEqual(
    build.commands.map((r) => r.command),
    buildCommands,
    "Missing build gate",
  );
  assert.ok(
    build.commands.every((r) => r.exitCode === 0),
    "Partial build gate",
  );
  assert.deepEqual(
    reports.map((r) => r.cell).sort(),
    [...matrixCells].sort(),
    "Missing or duplicate matrix cell",
  );
  for (const report of reports) {
    sameProducer(report.producer, producer);
    assert.equal(report.status, "PASS", "Matrix gate failed");
    assert.equal(
      `${report.platform}-${report.architecture}`,
      report.cell,
      "Wrong native architecture",
    );
    assert.equal(report.node, "24.21.0");
    assert.equal(
      report.inventorySha256,
      build.inventorySha256,
      "Mixed inventory",
    );
    assert.deepEqual(
      report.archives,
      inventory.targets.map((t) => ({
        id: t.id,
        sha256: t.sha256,
        bytes: t.bytes,
      })),
      "Wrong tested archives",
    );
    assert.deepEqual(
      report.modes.map((m) => m.mode),
      nativeModes,
      "Missing native gate",
    );
    for (const mode of report.modes) {
      assert.equal(mode.status, "PASS", "Native gate failed");
      assert.equal(mode.vscode, "1.141.0");
      assert.equal(mode.platform, report.platform);
      assert.equal(mode.arch, report.architecture);
      assert.equal(mode.trusted, mode.mode !== "restricted");
      if (mode.mode === "os-offline")
        assert.match(
          mode.networkIsolation,
          /^Disposable hosted isolation: (network-namespace|hosted-interfaces-down); external interfaces absent$/,
        );

      assert.equal(
        mode.archiveSha256,
        inventory.targets.find((t) => t.id === "vscode").sha256,
      );
    }
    assert.deepEqual(report.routes.map((r) => r.manager).sort(), [
      "npm",
      "pnpm",
    ]);
    for (const route of report.routes) {
      assert.equal(route.status, "PASS", "Consumer route failed");
      assert.ok(route.groups.length >= 26, "Missing consumer checks");
      assert.ok(
        route.commands.length > 0 &&
          route.commands.every((r) => r.exitCode === (r.expectedExitCode ?? 0)),
        "Consumer command failed",
      );
    }
    assert.equal(report.vscode.version, "1.141.0");
    assert.equal(
      report.vscode.commit,
      "2a59476c9bfcb90b3ddc372c36762471b7dfad1c",
    );
    assert.match(report.vscode.sha256, /^[a-f0-9]{64}$/);
    if (report.cell === "darwin-arm64") {
      assert.deepEqual(report.browsers.map((b) => b.browser).sort(), [
        "chromium",
        "firefox",
        "webkit",
      ]);
      assert.ok(
        report.browsers.every(
          (b) => b.status === "PASS" && b.version && b.integrity,
        ),
      );
    }
  }
}

export function assembleManifest(
  config,
  inventory,
  producer,
  build,
  reports,
  reportFiles,
) {
  checkReports(inventory, producer, build, reports);
  const environments = config.environments.map((environment) => {
    const report = reports.find(
      (r) => r.cell === `${environment.platform}-${environment.architecture}`,
    );
    const browser = report?.browsers.find(
      (b) => b.browser === environment.runtime,
    );
    return {
      ...environment,
      version:
        environment.runtime === "source"
          ? "1"
          : (browser?.version ?? environment.version),
      osVersion: report?.osRelease ?? build.osRelease,
      runtimeIntegrity:
        browser?.integrity ??
        (environment.runtime === "vscode"
          ? report.vscode.sha256
          : (report?.nodeSha256 ?? inventory.source.sha256)),
    };
  });
  const targets = [...config.packages, ...config.artifacts].map((target) => {
    const packed = inventory.targets.find((t) => t.id === target.id);
    const npm = config.packages.includes(target);
    const extension = target.id === "vscode";
    return {
      id: target.id,
      kind: npm ? "npm" : target.kind,
      name: npm
        ? target.proposedName
        : extension
          ? `${config.identities.marketplacePublisher.value}.${config.identities.extensionName.value}`
          : target.id,
      version: extension
        ? config.versions.extension
        : config.versions.implementation,
      channel: extension
        ? config.versions.extensionChannel
        : config.versions.npmChannel,
      dependencies: target.dependencies.map((id) => ({
        name: config.packages.find((p) => p.id === id).proposedName,
        version: config.versions.implementation,
      })),
      externalDependencies: target.externalDependencies,
      embeddedTargets: target.embeddedTargets,
      environments: target.environments,
      archive: {
        path: packed.archive,
        bytes: packed.bytes,
        sha256: packed.sha256,
        integrity: packed.integrity,
      },
      licenses: ["LICENSE", "THIRD_PARTY_NOTICES.txt"].map((path) => ({
        path,
        sha256: packed.files.find(
          (f) => f.path === (extension ? "extension/" : "") + path,
        ).sha256,
      })),
    };
  });
  const manifest = {
    schemaVersion: 1,
    ...releaseIdentity(config),
    source: {
      commit: producer.sourceSha,
      tree: producer.sourceTree,
      lockSha256: inventory.lockSha256,
      configSha256: inventory.configSha256,
    },
    versions: config.versions,
    targets,
    toolchain: build.tools,
    verification: {
      provider: "github-actions",
      runId: producer.runId,
      attempt: producer.attempt,
      environments,
      results: targets.flatMap((target) =>
        target.environments.map((id) => {
          const environment = environments.find((e) => e.id === id);
          const cell = `${environment.platform}-${environment.architecture}`;
          return {
            target: target.id,
            environment: id,
            status: "passed",
            checks: [
              environment.runtime === "source"
                ? "archive-inventory"
                : environment.runtime === "vscode"
                  ? "installed-workflow-restricted-performance-os-offline"
                  : "supplied-archive-consumer",
            ],
            report:
              reportFiles[environment.runtime === "source" ? "build" : cell],
          };
        }),
      ),
    },
    limitations: [
      "Public namespace ownership and publication authorization are separate from artifact verification.",
    ],
  };
  return validateReleaseManifest(manifest, config, inventory);
}

/** API and signature verification are supplied by the trusted caller, never by candidate JSON. */
export async function verifyProducer(index, expected, { api, attest, now }) {
  const p = index.producer;
  validateProducerIdentity(p);
  sameProducer(p, expected.producer);
  assert.equal(index.format, "tinta-candidate-1");
  assert.equal(index.retentionDays, retentionDays);
  const base = `/repos/${p.repository}`;
  const repository = await api(`${base}`);
  assert.equal(
    String(repository.id),
    p.repositoryId,
    "Repository renamed or replaced",
  );
  assert.equal(repository.full_name, p.repository);
  assert.equal(p.ref, `refs/heads/${repository.default_branch}`);
  const run = await api(
    `${base}/actions/runs/${p.runId}/attempts/${p.attempt}`,
  );
  assert.equal(String(run.id), p.runId);
  assert.equal(run.run_attempt, p.attempt, "Wrong attempt");
  assert.equal(run.repository.full_name, p.repository);
  assert.equal(String(run.repository.id), p.repositoryId);
  assert.equal(run.head_sha, p.sourceSha);
  assert.equal(run.event, p.event);
  assert.equal(run.path, p.workflow);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "Unsuccessful producer");
  const expiry = Date.parse(index.expiresAt);
  const created = Date.parse(index.createdAt);
  assert.ok(
    Number.isFinite(now) &&
      Number.isFinite(created) &&
      created <= now &&
      now < expiry,
    "Expired candidate",
  );
  assert.ok(
    expiry - created > 0 && expiry - created <= retentionDays * 86400000,
    "Invalid retention",
  );
  assert.ok(created >= Date.parse(run.created_at), "Candidate predates run");
  assert.ok(created <= Date.parse(run.updated_at), "Candidate postdates run");
  for (const record of [...index.storage, expected.candidateArtifact]) {
    assert.ok(Number.isSafeInteger(record.id) && record.id > 0);
    const artifact = await api(`${base}/actions/artifacts/${record.id}`);
    assert.equal(artifact.id, record.id);
    assert.equal(artifact.name, record.name);
    assert.equal(artifact.digest, record.digest, "Storage digest mismatch");
    assert.equal(artifact.workflow_run.id, Number(p.runId));
    assert.equal(artifact.workflow_run.head_sha, p.sourceSha);
    assert.equal(artifact.expired, false, "Expired storage");
    assert.ok(now < Date.parse(artifact.expires_at), "Expired storage");
    assert.ok(
      record.name.endsWith(`-${p.runId}-${p.attempt}`),
      "Wrong artifact attempt",
    );
  }
  assert.equal(
    expected.candidateArtifact.name,
    `candidate-${p.runId}-${p.attempt}`,
  );
  await attest(expected.indexPath, p);
  return true;
}
