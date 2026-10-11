import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  mkdtempSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, release } from "node:os";
import { chromium, firefox, webkit } from "@playwright/test";
import { runNativeMode, runNativeModes } from "./candidate-native.mjs";
import { captureCandidate } from "./candidate.mjs";
import { requireCommandSync, runCommandSync } from "./commands.mjs";
import { loadReleaseConfig } from "./release-contract.mjs";
import {
  candidateWorkflow,
  retentionDays,
  nativeModes,
  buildCommands,
  readCandidateJson,
  fileRecord,
  checkInventory,
  assembleManifest,
  validateProducerIdentity,
} from "./release-candidate.mjs";
import { digest } from "./distribution-archive.mjs";

const read = (path) => readCandidateJson(readFileSync(path));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const git = (...args) => requireCommandSync(["git", ...args]).stdout.trim();
const config = loadReleaseConfig();
const output = "reports/candidate";
mkdirSync(output, { recursive: true });

function preflight() {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Hosted dispatch required; local tests are fixtures only",
  );
  const event = read(process.env.GITHUB_EVENT_PATH);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(
    process.env.GITHUB_REF,
    `refs/heads/${event.repository.default_branch}`,
  );
  assert.equal(
    event.inputs.source_sha,
    process.env.GITHUB_SHA,
    "Explicit source must be the dispatched default-branch commit",
  );
  assert.equal(
    event.inputs.config_sha256,
    digest(readFileSync("toolchain/release.json")),
    "Unreviewed release configuration",
  );
  assert.equal(git("rev-parse", "HEAD"), event.inputs.source_sha);
  assert.equal(
    git("status", "--porcelain"),
    "",
    "Clean committed source required",
  );
  requireCommandSync([
    "git",
    "merge-base",
    "--is-ancestor",
    event.inputs.source_sha,
    `origin/${event.repository.default_branch}`,
  ]);
  const producer = {
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    workflow: candidateWorkflow,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    sourceSha: event.inputs.source_sha,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    event: process.env.GITHUB_EVENT_NAME,
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ref: process.env.GITHUB_REF,
  };
  validateProducerIdentity(producer);
  assert.equal(
    process.env.GITHUB_WORKFLOW_REF,
    `${producer.repository}/${candidateWorkflow}@${producer.ref}`,
  );
  assert.equal(process.versions.node, "24.21.0");
  assert.equal(
    requireCommandSync(["pnpm", "--version"]).stdout.trim(),
    "10.34.6",
  );
  assert.equal(
    requireCommandSync([
      "node",
      process.env.TINTA_NPM_CLI,
      "--version",
    ]).stdout.trim(),
    "11.19.0",
  );
  return producer;
}

function tools() {
  const dependencies = read("toolchain/dependencies.json");
  const names = {
    pnpm: "pnpm",
    typescript: "typescript",
    esbuild: "esbuild",
    playwright: "@playwright/test",
    vite: "vite",
  };
  return [
    {
      name: "node",
      version: process.versions.node,
      integrity: "sha256:" + digest(readFileSync(process.execPath)),
    },
    {
      name: "npm",
      version: "11.19.0",
      integrity: "sha256:" + digest(readFileSync(process.env.TINTA_NPM_CLI)),
    },
    ...Object.entries(names).map(([name, upstream]) => {
      const record = dependencies.find((r) => r.name === upstream);
      assert.ok(record?.dist.integrity, `Missing tool provenance: ${name}`);
      return {
        name,
        version: record.version,
        integrity: record.dist.integrity,
      };
    }),
    {
      name: "packaging-scripts",
      version: "git",
      integrity:
        "sha256:" + digest(readFileSync("scripts/distribution-package.mjs")),
    },
    {
      name: "actions",
      version: "committed-inventory",
      integrity: "sha256:" + digest(readFileSync("toolchain/actions.json")),
    },
  ];
}

async function api(path) {
  assert.match(path, /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/);
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `GitHub metadata request failed: ${response.status}`);
  return response.json();
}

const producer = preflight();
const command = process.argv[2];
if (command === "build") {
  const report = {
    producer,
    status: "FAIL",
    osRelease: release(),
    tools: tools(),
    commands: [],
  };
  for (const command of buildCommands) {
    const result = runCommandSync(command);
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    report.commands.push({ command, exitCode: result.status });
    save(join(output, "build.json"), report);
    assert.equal(result.status, 0, "Candidate build gate failed");
  }
  const inventory = checkInventory("build/distribution", config, {
    clean: true,
  });
  assert.equal(
    inventory.source.sha256,
    captureCandidate().sourceSha256,
    "Source changed during build",
  );
  report.inventorySha256 = digest(
    readFileSync("build/distribution/inventory.json"),
  );
  report.status = "PASS";
  save(join(output, "build.json"), report);
  copyFileSync(join(output, "build.json"), "build/distribution/build.json");
} else if (command === "matrix") {
  const directory = resolve("build/supplied");
  const inventory = checkInventory(directory, config, { clean: true });
  const cell = `${process.platform}-${process.arch}`;
  assert.equal(cell, process.env.TINTA_MATRIX_CELL);
  const report = {
    producer,
    cell,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    node: process.versions.node,
    nodeSha256: digest(readFileSync(process.execPath)),
    inventorySha256: digest(readFileSync(join(directory, "inventory.json"))),
    status: "FAIL",
    modes: [],
  };
  const reportPath = join(output, `${cell}.json`);
  try {
    requireCommandSync(
      [
        "node",
        "scripts/consumer-dependencies.mjs",
        join(directory, "inventory.json"),
        "build/consumer-dependencies",
        "--download",
      ],
      { stdio: "inherit" },
    );
    requireCommandSync(
      [
        "node",
        "scripts/consumer-artifacts.mjs",
        join(directory, "inventory.json"),
        "build/consumer-dependencies",
        join(output, "consumer.json"),
      ],
      { stdio: "inherit" },
    );
    const consumer = read(join(output, "consumer.json"));
    assert.equal(consumer.status, "PASS");
    assert.equal(consumer.inventorySha256, report.inventorySha256);
    report.routes = consumer.routes;
    report.archives = consumer.archives;
    report.browsers = consumer.browsers.map((b) => ({
      ...b,
      integrity:
        "sha256:" +
        digest(
          readFileSync(
            { chromium, firefox, webkit }[b.browser].executablePath(),
          ),
        ),
    }));
    const desktop = process.env.TINTA_VSCODE_EXECUTABLE;
    const cli = process.env.TINTA_VSCODE_CLI;
    assert.ok(desktop && cli, "Pinned desktop and CLI required");
    const product = read(process.env.TINTA_VSCODE_PRODUCT);
    const application = read(process.env.TINTA_VSCODE_PACKAGE);
    assert.equal(product.commit, "2a59476c9bfcb90b3ddc372c36762471b7dfad1c");
    assert.equal(application.version, "1.141.0");
    report.vscode = {
      version: application.version,
      commit: product.commit,
      sha256: digest(readFileSync(desktop)),
    };
    const temporary = mkdtempSync(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tinta-ci-"),
    );
    const vsix = join(
      directory,
      inventory.targets.find((t) => t.id === "vscode").archive,
    );
    runNativeModes(nativeModes, (mode) => {
      const root = join(temporary, mode);
      const invocation = [
        process.execPath,
        "scripts/test-vscode-installed.mjs",
        desktop,
        cli,
        vsix,
        root,
        "--release",
        `--${mode}`,
      ];
      runNativeMode(invocation, root, join(output, `native-${mode}.json`), {
        offline: mode === "os-offline",
      });
      const result = read(join(root, "result.json"));
      report.modes.push({ mode, ...result });
      save(reportPath, report);
    });
    checkInventory(directory, config, { clean: true });
    report.status = "PASS";
  } finally {
    save(reportPath, report);
  }
} else if (command === "assemble") {
  const directory = "build/supplied";
  const inventory = checkInventory(directory, config, { clean: true });
  const build = read(join(directory, "build.json"));
  const reportFiles = {
    build: fileRecord(
      "build.json",
      readFileSync(join(directory, "build.json")),
    ),
  };
  const reports = [];
  for (const cell of ["darwin-arm64", "linux-arm64", "win32-x64"]) {
    const bytes = readFileSync(`build/results/${cell}/${cell}.json`);
    reports.push(readCandidateJson(bytes));
    writeFileSync(join(directory, `${cell}.json`), bytes);
    reportFiles[cell] = fileRecord(`${cell}.json`, bytes);
  }
  const manifest = assembleManifest(
    config,
    inventory,
    producer,
    build,
    reports,
    reportFiles,
  );
  const manifestPath = join(directory, "release-manifest.json");
  save(manifestPath, manifest);
  const manifestBytes = readFileSync(manifestPath);
  writeFileSync(manifestPath + ".sha256", digest(manifestBytes) + "\n");
  const response = await api(
    `/repos/${producer.repository}/actions/runs/${producer.runId}/artifacts?per_page=100`,
  );
  assert.ok(response.total_count <= 100, "Artifact pagination limit");
  const names = ["payloads", ...reports.map((r) => `results-${r.cell}`)];
  const storage = names.map((prefix) => {
    const name = `${prefix}-${producer.runId}-${producer.attempt}`;
    const found = response.artifacts.filter((a) => a.name === name);
    assert.equal(found.length, 1, "Missing or ambiguous artifact");
    const artifact = found[0];
    assert.equal(artifact.expired, false);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
    if (prefix === "payloads")
      assert.equal(String(artifact.id), process.env.TINTA_PAYLOAD_ID);
    return {
      id: artifact.id,
      name,
      digest: artifact.digest,
      expiresAt: artifact.expires_at,
    };
  });
  const now = Date.now();
  const expires = Math.min(
    now + retentionDays * 86400000,
    ...storage.map((s) => Date.parse(s.expiresAt)),
  );
  assert.ok(expires > now);
  save(join(directory, "candidate-index.json"), {
    format: "tinta-candidate-1",
    producer,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    retentionDays,
    storage,
    manifest: fileRecord("release-manifest.json", manifestBytes),
    inventory: fileRecord(
      "inventory.json",
      readFileSync(join(directory, "inventory.json")),
    ),
    reports: reportFiles,
  });
} else {
  throw new Error("Expected build, matrix or assemble");
}
