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
  selectedTargets,
  selectedEnvironments,
  targetVersion,
  dependencyClosure,
  validateReleaseManifest,
} from "./release-contract.mjs";

export const candidateWorkflow = ".github/workflows/publish-release.yml";
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
export function validateVerification(receipt, producer) {
  assert.ok(receipt, "Missing successful source verification");
  assert.equal(receipt.workflow, verificationWorkflow);
  assert.equal(receipt.sourceSha, producer.sourceSha, "Verify source mismatch");
  assert.equal(receipt.conclusion, "success");
  assert.match(receipt.runId, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0);
  return receipt;
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
    inventory.component,
    process.env.TINTA_COMPONENT,
    "Mixed component",
  );
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
    assert.equal(plan.studio, config.versions.studio);
    const notes = inventory.component
      ? plan.components[inventory.component].notes
      : plan.notes;
    assert.equal(typeof notes, "string");
    assert.ok(notes.trim());
  }
  const expected = selectedTargets(config);
  const prerequisites =
    inventory.component === "studio"
      ? config.packages.filter(
          (target) =>
            dependencyClosure(config, "cli").includes(target.id) &&
            target.id !== "cli",
        )
      : [];
  assert.deepEqual(
    (inventory.verificationPackages ?? []).map((target) => target.id).sort(),
    prerequisites.map((target) => target.id).sort(),
    "Verification dependency inventory",
  );
  assert.deepEqual(
    inventory.targets.map((t) => t.id).sort(),
    expected.map((t) => t.id).sort(),
    "Target inventory",
  );
  const paths = inventory.targets.map((t) => t.archive);
  assert.equal(new Set(paths).size, paths.length, "Duplicate archive path");
  for (const target of [
    ...inventory.targets,
    ...(inventory.verificationPackages ?? []),
  ]) {
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
      assert.equal(manifest.version, targetVersion(config, target.id));
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
  assert.equal(producer.workflow, candidateWorkflow);
  assert.equal(producer.event, "workflow_run");
  assert.match(producer.ref, /^refs\/heads\/[A-Za-z0-9/_.-]+$/);
  assert.ok(Number.isSafeInteger(producer.attempt) && producer.attempt > 0);
}

export function checkReports(inventory, producer, build, reports) {
  validateProducerIdentity(producer);
  assert.equal(
    inventory.component,
    process.env.TINTA_COMPONENT,
    "Report component mismatch",
  );
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
  const extension = inventory.targets.some((target) => target.id === "vscode");
  const node = inventory.targets.some((target) =>
    target.archive.endsWith(".tgz"),
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
      extension ? nativeModes : [],
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
    assert.deepEqual(
      report.routes.map((r) => r.manager).sort(),
      node ? ["npm", "pnpm"] : [],
    );
    for (const route of report.routes) {
      assert.equal(route.status, "PASS", "Consumer route failed");
      if (!inventory.component)
        assert.ok(route.groups.length >= 26, "Missing consumer checks");
      else {
        for (const group of [
          "declarations:strict-node-next",
          "parser:budget-depth-recovery-spans",
          "engine:compile-evaluate",
          ...(inventory.component === "language"
            ? [
                "language-service:queries",
                "ipc:server-worker-handshake",
                "ipc:watchdog-restart-production-worker",
                "artifacts:installed-exports",
              ]
            : ["cli:images-grants-exports-bundle-studio"]),
        ])
          assert.ok(
            route.groups.includes(group),
            `Missing consumer check: ${group}`,
          );
        assert.ok(
          inventory.targets
            .filter((target) => target.archive.endsWith(".tgz"))
            .every((target) =>
              route.groups.some((group) =>
                group.startsWith(`export:@tinta-lang/${target.id}`),
              ),
            ),
          "Missing package export checks",
        );
      }
      assert.ok(
        route.commands.length > 0 &&
          route.commands.every((r) => r.exitCode === (r.expectedExitCode ?? 0)),
        "Consumer command failed",
      );
    }
    if (extension) {
      assert.equal(report.vscode.version, "1.141.0");
      assert.equal(
        report.vscode.commit,
        "2a59476c9bfcb90b3ddc372c36762471b7dfad1c",
      );
      assert.match(report.vscode.sha256, /^[a-f0-9]{64}$/);
    } else assert.equal(report.vscode, undefined);
    if (report.cell === "darwin-arm64" && node) {
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
  const environments = selectedEnvironments(config).map((environment) => {
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
  const targets = selectedTargets(config).map((target) => {
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
      version: targetVersion(config, target.id),
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
    schemaVersion: inventory.component ? 2 : 1,
    ...(inventory.component ? { component: inventory.component } : {}),
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
    limitations: ["Publication across independent services is not atomic."],
  };
  return validateReleaseManifest(manifest, config, inventory);
}
