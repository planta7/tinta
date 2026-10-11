import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  buildCommands,
  nativeModes,
  matrixCells,
  candidateWorkflow,
  readCandidateJson,
  checkReports,
  assembleManifest,
  verifyProducer,
  validateProducerIdentity,
} from "../../scripts/release-candidate.mjs";
import { offlineInstalled } from "../../scripts/candidate-offline.mjs";
import { verifyAttestation } from "../../scripts/verify-release-candidate.mjs";
import { loadReleaseConfig } from "../../scripts/release-contract.mjs";

const hash = "a".repeat(64);
const source = "b".repeat(40);
const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
const config = loadReleaseConfig();
const producer = {
  repository: "fixture/tinta",
  repositoryId: "42",
  workflow: candidateWorkflow,
  workflowSha: source,
  sourceSha: source,
  sourceTree: "c".repeat(40),
  event: "workflow_dispatch",
  runId: "123",
  attempt: 2,
  ref: "refs/heads/main",
};
const file = (path) => ({ path, bytes: 10, sha256: hash, integrity });

function fixture() {
  const inventory = {
    source: { commit: source, dirty: false, sha256: hash },
    versions: config.versions,
    lockSha256: hash,
    configSha256: hash,
    targets: [...config.packages, ...config.artifacts].map((t) => ({
      id: t.id,
      archive:
        t.id +
        (config.packages.includes(t)
          ? ".tgz"
          : t.id === "vscode"
            ? ".vsix"
            : ".zip"),
      bytes: 10,
      sha256: hash,
      integrity,
      files: ["LICENSE", "THIRD_PARTY_NOTICES.txt"].map((path) => ({
        path: (t.id === "vscode" ? "extension/" : "") + path,
        sha256: hash,
      })),
    })),
  };
  const build = {
    producer,
    status: "PASS",
    osRelease: "fixture-os",
    inventorySha256: hash,
    tools: [
      ...Object.entries({
        pnpm: "pnpm",
        typescript: "typescript",
        esbuild: "esbuild",
        playwright: "@playwright/test",
        vite: "vite",
      }).map(([name, upstream]) => {
        const pin = JSON.parse(
          readFileSync("toolchain/dependencies.json"),
        ).find((tool) => tool.name === upstream);
        return { name, version: pin.version, integrity: pin.dist.integrity };
      }),
      ...[
        ["node", "24.21.0"],
        ["npm", "11.19.0"],
      ].map(([name, version]) => ({
        name,
        version,
        integrity: "sha256:" + hash,
      })),
    ],
    commands: buildCommands.map((command) => ({ command, exitCode: 0 })),
  };
  const reports = matrixCells.map((cell) => ({
    producer,
    cell,
    platform: cell.split("-")[0],
    architecture: cell.split("-")[1],
    status: "PASS",
    node: "24.21.0",
    nodeSha256: hash,
    osRelease: "fixture-os",
    inventorySha256: hash,
    archives: inventory.targets.map((t) => ({
      id: t.id,
      sha256: t.sha256,
      bytes: t.bytes,
    })),
    modes: nativeModes.map((mode) => ({
      mode,
      status: "PASS",
      archiveSha256: hash,
      vscode: "1.141.0",
      platform: cell.split("-")[0],
      arch: cell.split("-")[1],
      trusted: mode !== "restricted",
      networkIsolation:
        "Disposable hosted isolation: network-namespace; external interfaces absent",
    })),
    routes: ["npm", "pnpm"].map((manager) => ({
      manager,
      status: "PASS",
      groups: Array.from({ length: 26 }, (_, n) => `fixture-check-${n}`),
      commands: [{ exitCode: 0 }],
    })),
    vscode: {
      version: "1.141.0",
      commit: "2a59476c9bfcb90b3ddc372c36762471b7dfad1c",
      sha256: hash,
    },
    browsers: ["chromium", "firefox", "webkit"].map((browser) => ({
      browser,
      status: "PASS",
      version: "123.0",
      integrity,
    })),
  }));
  return structuredClone({ inventory, build, reports });
}

function transportFixture() {
  const records = [
    "payloads",
    ...matrixCells.map((c) => `results-${c}`),
    "candidate",
  ].map((prefix, n) => ({
    id: n + 1,
    name: `${prefix}-123-2`,
    digest: `sha256:${hash}`,
    expired: false,
    expires_at: "2026-11-10T00:00:00Z",
    workflow_run: { id: 123, head_sha: source },
  }));
  const index = {
    format: "tinta-candidate-1",
    producer: structuredClone(producer),
    retentionDays: 30,
    createdAt: "2026-10-11T00:00:00Z",
    expiresAt: "2026-11-10T00:00:00Z",
    storage: records
      .slice(0, 4)
      .map(({ id, name, digest }) => ({ id, name, digest })),
  };
  const run = {
    id: 123,
    run_attempt: 2,
    repository: { id: 42, full_name: "fixture/tinta" },
    head_sha: source,
    event: "workflow_dispatch",
    path: candidateWorkflow,
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-10T23:00:00Z",
    updated_at: "2026-10-11T01:00:00Z",
  };
  let signatures = 0;
  return {
    index,
    run,
    records,
    expected: {
      producer: structuredClone(producer),
      candidateArtifact: records[4],
      indexPath: "fixture-index.json",
    },
    services: {
      now: Date.parse("2026-10-12T00:00:00Z"),
      api: async (path) => {
        if (path.endsWith("/attempts/2")) return run;
        if (path.includes("/artifacts/"))
          return records.find((r) => path.endsWith(`/${r.id}`));
        return { id: 42, full_name: "fixture/tinta", default_branch: "main" };
      },
      attest: async () => {
        signatures++;
      },
    },
    signatures: () => signatures,
  };
}

describe("frozen candidate metadata", () => {
  it("assembles every configured target/environment from the same supplied hashes", () => {
    const f = fixture();
    const reports = Object.fromEntries(
      ["build", ...matrixCells].map((id) => [id, file(`${id}.json`)]),
    );
    const manifest = assembleManifest(
      config,
      f.inventory,
      producer,
      f.build,
      f.reports,
      reports,
    );
    expect(manifest.targets).toHaveLength(16);
    expect(manifest.verification.results).toHaveLength(
      config.packages
        .concat(config.artifacts)
        .reduce((n, t) => n + t.environments.length, 0),
    );
    expect(
      manifest.verification.results.every((r) => r.status === "passed"),
    ).toBe(true);
  });
  it.each([
    [
      "dirty source",
      (f) => {
        f.inventory.source.dirty = true;
      },
    ],
    [
      "wrong source",
      (f) => {
        f.inventory.source.commit = "d".repeat(40);
      },
    ],
    [
      "missing matrix cell",
      (f) => {
        f.reports.pop();
      },
    ],
    [
      "duplicate cell",
      (f) => {
        f.reports[2] = f.reports[0];
      },
    ],
    [
      "wrong architecture",
      (f) => {
        f.reports[1].architecture = "x64";
      },
    ],
    [
      "mixed inventory",
      (f) => {
        f.reports[0].inventorySha256 = "d".repeat(64);
      },
    ],
    [
      "changed archive",
      (f) => {
        f.reports[0].archives[0].sha256 = "d".repeat(64);
      },
    ],
    [
      "partial command",
      (f) => {
        f.build.commands[0].exitCode = null;
      },
    ],
    [
      "missing command",
      (f) => {
        f.build.commands.pop();
      },
    ],
    [
      "missing native gate",
      (f) => {
        f.reports[0].modes.pop();
      },
    ],
    [
      "offline failure",
      (f) => {
        f.reports[0].modes[3].status = "BLOCKED";
      },
    ],
    [
      "wrong desktop",
      (f) => {
        f.reports[0].vscode.commit = source;
      },
    ],
    [
      "missing browser",
      (f) => {
        f.reports[0].browsers.pop();
      },
    ],
    [
      "wrong attempt",
      (f) => {
        f.reports[0].producer.attempt = 3;
      },
    ],
  ])("rejects %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() =>
      checkReports(f.inventory, producer, f.build, f.reports),
    ).toThrow();
  });
  it("rejects malformed UTF-8, duplicate keys and oversized metadata", () => {
    expect(() => readCandidateJson(Buffer.from('{"a":1,"a":2}'))).toThrow();
    expect(() => readCandidateJson(Buffer.from([255]))).toThrow();
    expect(() =>
      readCandidateJson(Buffer.alloc(16 * 1024 * 1024 + 1)),
    ).toThrow();
    expect(() =>
      validateProducerIdentity({ ...producer, extra: true }),
    ).toThrow();
    expect(() =>
      validateProducerIdentity({ ...producer, event: "pull_request" }),
    ).toThrow();
  });
});

describe("trusted producer with fixture CI, storage and signature services", () => {
  it("requires successful exact run, storage identity, expiry and cryptographic verification", async () => {
    const f = transportFixture();
    await expect(verifyProducer(f.index, f.expected, f.services)).resolves.toBe(
      true,
    );
    expect(f.signatures()).toBe(1);
  });
  it.each([
    [
      "repository",
      (f) => {
        f.run.repository.id = 99;
      },
    ],
    [
      "run",
      (f) => {
        f.run.id = 456;
      },
    ],
    [
      "attempt",
      (f) => {
        f.run.run_attempt = 1;
      },
    ],
    [
      "source",
      (f) => {
        f.run.head_sha = "e".repeat(40);
      },
    ],
    [
      "workflow",
      (f) => {
        f.run.path = ".github/workflows/verify.yml";
      },
    ],
    [
      "event",
      (f) => {
        f.run.event = "pull_request";
      },
    ],
    [
      "failure",
      (f) => {
        f.run.conclusion = "failure";
      },
    ],
    [
      "incomplete run",
      (f) => {
        f.run.status = "in_progress";
      },
    ],
    [
      "expired candidate",
      (f) => {
        f.services.now = Date.parse(f.index.expiresAt);
      },
    ],
    [
      "extended retention",
      (f) => {
        f.index.expiresAt = "2026-12-11T00:00:00Z";
      },
    ],
    [
      "expired storage",
      (f) => {
        f.records[0].expired = true;
      },
    ],
    [
      "changed storage",
      (f) => {
        f.records[0].digest = `sha256:${"d".repeat(64)}`;
      },
    ],
    [
      "wrong artifact run",
      (f) => {
        f.records[0].workflow_run.id = 124;
      },
    ],
    [
      "old artifact attempt",
      (f) => {
        f.records[0].name = "payloads-123-1";
      },
    ],
    [
      "API denied",
      (f) => {
        f.services.api = async () => {
          throw new Error("403");
        };
      },
    ],
    [
      "invalid signature",
      (f) => {
        f.services.attest = async () => {
          throw new Error("signature");
        };
      },
    ],
  ])("rejects %s", async (_name, change) => {
    const f = transportFixture();
    change(f);
    await expect(
      verifyProducer(f.index, f.expected, f.services),
    ).rejects.toThrow();
  });
  it("pins signer/source and requires the verified invocation, never a raw copied predicate", () => {
    const calls = [];
    const execute = (command) => {
      calls.push(command);
      return {
        stdout:
          command[1] === "--version"
            ? "gh version 2.102.0 (fixture)"
            : JSON.stringify([
                {
                  verificationResult: {
                    statement: {
                      predicate: {
                        runDetails: {
                          metadata: {
                            invocationId:
                              "https://github.com/fixture/tinta/actions/runs/123/attempts/2",
                          },
                        },
                      },
                    },
                  },
                },
              ]),
      };
    };
    verifyAttestation("fixture.json", producer, execute);
    expect(calls[1]).toContain("--signer-digest");
    expect(calls[1]).toContain("--source-digest");
    expect(() =>
      verifyAttestation("fixture.json", { ...producer, attempt: 3 }, execute),
    ).toThrow();
    expect(() =>
      verifyAttestation("fixture.json", producer, () => ({ stdout: "[]" })),
    ).toThrow();
  });
});

describe("candidate workflow security topology", () => {
  it("isolates attestation, binds exact downloads and never rebuilds in consumers", () => {
    const workflow = parse(readFileSync(candidateWorkflow, "utf8"));
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.build.needs).toBe("provenance-capability");
    expect(
      workflow.jobs["provenance-capability"].steps.every((s) => !s.run),
    ).toBe(true);
    expect(workflow.jobs.attest.needs).toEqual(["build", "installed"]);
    expect(workflow.jobs.attest.permissions).toEqual({
      contents: "read",
      actions: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(
      workflow.jobs.installed.strategy.matrix.include.map((c) => c.cell),
    ).toEqual(matrixCells);
    const installedSteps = workflow.jobs.installed.steps;
    const checkout = installedSteps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout).toBeGreaterThan(0);
    expect(installedSteps[checkout - 1].run).toBe(
      "git config --global core.autocrlf false",
    );
    const pins = JSON.parse(readFileSync("toolchain/actions.json", "utf8"));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      for (const step of job.steps) {
        if (step.uses) {
          const [action, sha] = step.uses.split("@");
          expect(
            pins.some(
              (p) =>
                p.repository === `https://github.com/${action}` &&
                p.commit === sha,
            ),
          ).toBe(true);
          if (action === "actions/upload-artifact") {
            expect(step.with["retention-days"]).toBe(30);
            expect(step.with.overwrite).not.toBe(true);
          }
        }
        if (step.run) {
          expect(step.run).not.toContain("${{");
          if (name !== "build")
            expect(step.run).not.toMatch(
              /distribution-package|pnpm build|package:vscode/,
            );
        }
      }
    }
    const ordinary = parse(
      readFileSync(".github/workflows/verify.yml", "utf8"),
    );
    for (const job of Object.values(ordinary.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.steps.some((s) => /attest@/.test(s.uses ?? ""))).toBe(false);
    }
    expect(
      ordinary.jobs["release-preparation"].steps.some(
        (s) =>
          s.run ===
          "node scripts/check-release-artifacts.mjs build/distribution",
      ),
    ).toBe(true);
  });
});

it("refuses to disconnect local or self-hosted computers", () => {
  const actions = process.env.GITHUB_ACTIONS;
  const environment = process.env.RUNNER_ENVIRONMENT;
  try {
    process.env.GITHUB_ACTIONS = "false";
    expect(() => offlineInstalled([])).toThrow();
    process.env.GITHUB_ACTIONS = "true";
    process.env.RUNNER_ENVIRONMENT = "self-hosted";
    expect(() => offlineInstalled([])).toThrow();
  } finally {
    if (actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = actions;
    if (environment === undefined) delete process.env.RUNNER_ENVIRONMENT;
    else process.env.RUNNER_ENVIRONMENT = environment;
  }
});

it("refuses an actual dirty Git checkout before building a candidate", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "tinta-dirty-fixture-"));
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(root, "toolchain"));
    const configuration = readFileSync("toolchain/release.json");
    writeFileSync(join(root, "toolchain/release.json"), configuration);
    git("init", "--initial-branch=main");
    git("add", "toolchain/release.json");
    git("-c", "commit.gpgsign=false", "commit", "-m", "Synthetic test fixture");
    const sha = git("rev-parse", "HEAD");
    const event = join(root, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        repository: { default_branch: "main" },
        inputs: {
          source_sha: sha,
          config_sha256: createHash("sha256")
            .update(configuration)
            .digest("hex"),
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/candidate-ci.mjs"), "build"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_PATH: event,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: sha,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Clean committed source required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("locates global package managers without a pnpm exec environment variable", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "tinta tools fixture "));
  try {
    for (const name of ["pnpm", "npm"])
      mkdirSync(join(root, name, "bin"), { recursive: true });
    writeFileSync(join(root, "pnpm/bin/pnpm.cjs"), "fixture");
    writeFileSync(join(root, "npm/bin/npm-cli.js"), "fixture");
    const envFile = join(root, "environment.txt");
    const env = {
      ...process.env,
      TINTA_GLOBAL_MODULES: root,
      GITHUB_ENV: envFile,
    };
    delete env.npm_execpath;
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/candidate-tools.mjs")],
      { env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(envFile, "utf8");
    expect(output).toContain(
      `TINTA_NPM_CLI=${join(root, "npm/bin/npm-cli.js")}`,
    );
    expect(output).toContain(`npm_execpath=${join(root, "pnpm/bin/pnpm.cjs")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
