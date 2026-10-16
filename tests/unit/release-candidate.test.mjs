import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import vscodeConfig from "../../scripts/vscode-vitest.config.js";
import {
  buildCommands,
  validateVerification,
  verificationWorkflow,
  nativeModes,
  matrixCells,
  candidateWorkflow,
  readCandidateJson,
  checkReports,
  assembleManifest,
  validateProducerIdentity,
} from "../../scripts/release-candidate.mjs";
import { digest } from "../../scripts/distribution-archive.mjs";
import { offlineInstalled } from "../../scripts/candidate-offline.mjs";
import {
  loadReleaseConfig,
  selectedTargets,
} from "../../scripts/release-contract.mjs";

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
  event: "workflow_run",
  runId: "123",
  attempt: 2,
  ref: "refs/heads/main",
};
const file = (path) => ({ path, bytes: 10, sha256: hash, integrity });

function verificationFixture() {
  return {
    workflow: verificationWorkflow,
    sourceSha: producer.sourceSha,
    conclusion: "success",
    runId: "77",
    attempt: 2,
  };
}

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
      files: [
        t.id === "vscode" ? "LICENSE.txt" : "LICENSE",
        "THIRD_PARTY_NOTICES.txt",
      ].map((path) => ({
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
    verification: verificationFixture(),
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

it("requires successful matching source verification in the build report", () => {
  const f = fixture();
  delete f.build.verification;
  expect(() => checkReports(f.inventory, producer, f.build, f.reports)).toThrow(
    "Missing successful source verification",
  );
  const changed = { ...verificationFixture(), sourceSha: "d".repeat(40) };
  expect(() => validateVerification(changed, producer)).toThrow(
    "source mismatch",
  );
});

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
    expect(
      manifest.targets.find((target) => target.id === "vscode").licenses,
    ).toEqual([
      { path: "LICENSE.txt", sha256: hash },
      { path: "THIRD_PARTY_NOTICES.txt", sha256: hash },
    ]);
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

it("binds official publication jobs to tested archives and the trusted workflow run", () => {
  const workflow = parse(readFileSync(candidateWorkflow, "utf8"));
  expect(Object.keys(workflow.on)).toEqual([
    "workflow_dispatch",
    "workflow_run",
  ]);
  expect(workflow.on.workflow_dispatch.inputs.studio_tag).toMatchObject({
    required: true,
    type: "string",
  });
  expect(workflow.jobs.build.if).toContain(
    "github.event_name == 'workflow_run'",
  );
  expect(workflow.jobs["deploy-studio"].if).toContain(
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  expect(workflow.permissions).toEqual({});
  for (const condition of [
    "conclusion == 'success'",
    "event == 'push'",
    "head_branch == 'main'",
    "head_sha == github.sha",
    "head_repository.full_name == github.repository",
  ])
    expect(workflow.jobs.build.if).toContain(condition);
  for (const name of ["build", "installed"])
    expect(workflow.jobs[name].permissions).toEqual({ contents: "read" });
  for (const name of ["release-language", "release"]) {
    expect(workflow.jobs[name].environment).toBe("release");
    expect(workflow.jobs[name].permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(
      workflow.jobs[name].steps.find(
        (step) => step.name === "Publish the tested npm targets",
      ).run,
    ).toContain('.targets[] | select(.archive | endswith(".tgz"))');
    expect(
      workflow.jobs[name].steps.find((step) =>
        step.uses?.startsWith("Azure/login@"),
      ).if,
    ).toBe("env.TINTA_COMPONENT == 'vscode'");
  }
  expect(workflow.jobs.installed.strategy["fail-fast"]).toBe(false);
  expect(
    workflow.jobs.installed.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ).if,
  ).toBe("always()");
  expect(workflow.jobs.release.strategy["fail-fast"]).toBe(false);
  expect(workflow.jobs["release-language"].needs).toEqual([
    "build",
    "installed",
  ]);
  expect(workflow.jobs.release.needs).toEqual([
    "build",
    "installed",
    "release-language",
  ]);
  expect(workflow.jobs.release.if).toContain(
    "needs.release-language.result == 'success'",
  );
  expect(workflow.jobs.release.if).toContain(
    "needs.release-language.result == 'skipped'",
  );
  expect(
    workflow.jobs.installed.strategy.matrix.native.map((cell) => cell.cell),
  ).toEqual(matrixCells);
  expect(workflow.jobs.installed.strategy.matrix.component).toBe(
    "${{ fromJSON(needs.build.outputs.matrix).component }}",
  );
  expect(workflow.jobs.release.steps).toEqual(
    workflow.jobs["release-language"].steps,
  );
  for (const [name, job] of Object.entries(workflow.jobs)) {
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (
        step.uses?.startsWith("actions/download-artifact@") &&
        step.with["artifact-ids"]
      )
        expect(step.with["artifact-ids"]).toMatch(
          /^\$\{\{ needs\.(build|release)\.outputs\./,
        );
      if (step.uses?.startsWith("actions/upload-artifact@"))
        expect(step.with.overwrite).not.toBe(true);
      if (step.run) {
        expect(step.run).not.toContain("${{");
        expect(step.run).not.toMatch(/--(?:clobber|skip-duplicate)/);
        if (name !== "build")
          expect(step.run).not.toMatch(
            /distribution-package|pnpm build|package:vscode/,
          );
      }
    }
  }
  const ci = parse(readFileSync(verificationWorkflow, "utf8"));
  expect(ci.on).toEqual({
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  });
  expect(ci.permissions).toEqual({ contents: "read" });
  const selection = ci.jobs.verify.steps.find((step) => step.id === "affected");
  expect(selection.run).toContain('if [ "$GITHUB_EVENT_NAME" = push ]; then');
  expect(selection.run).toContain(
    'node scripts/release-plan.mjs --affected "$BEFORE" "$SOURCE" --pending',
  );
  expect(vscodeConfig.test.include).toEqual(
    expect.arrayContaining([
      "tests/unit/vscode-package.test.mjs",
      "tests/unit/installed-preview.test.mjs",
    ]),
  );
  expect(
    ci.jobs.verify.steps.find(
      (step) => step.run === "pnpm verify --suite editing",
    ).if,
  ).toBe("steps.affected.outputs.language == 'true'");
  expect(
    ci.jobs.verify.steps.find((step) => step.run === "pnpm test:vscode:browser")
      .if,
  ).toBe("steps.affected.outputs.vscode == 'true'");
  expect(ci.jobs["cli-portability"].strategy.matrix.os).toEqual([
    "macos-15",
    "windows-2022",
  ]);
  expect(
    ci.jobs["cli-portability"].steps.find(
      (step) => step.name === "Report component selection",
    ).run,
  ).toContain("not applicable");
  expect(buildCommands).toContainEqual([
    "node",
    "scripts/distribution-package.mjs",
    "--built",
  ]);
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
    mkdirSync(join(root, "reports/release"), { recursive: true });
    writeFileSync(
      join(root, "reports/release/plan.json"),
      JSON.stringify({
        sourceSha: sha,
        implementation: "0.1.22",
        extension: "0.2.22",
        npmChannel: "latest",
        extensionChannel: "stable",
      }),
    );
    const event = join(root, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        workflow_run: {
          path: ".github/workflows/verify.yml",
          event: "push",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: sha,
          head_repository: { full_name: "fixture/tinta", id: 42 },
        },
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
          TINTA_RELEASE_SOURCE_SHA: sha,
          GITHUB_REPOSITORY: "fixture/tinta",
          GITHUB_REPOSITORY_ID: "42",
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_PATH: event,
          GITHUB_EVENT_NAME: "workflow_run",
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

it("executes the Pages guards and rejects incomplete, stale or changed downloads", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { zipEntries } = await import("../../scripts/distribution-archive.mjs");
  const root = mkdtempSync(join(tmpdir(), "tinta pipeline fixture "));
  const workflow = parse(readFileSync(candidateWorkflow, "utf8"));
  const steps = workflow.jobs["deploy-studio"].steps;
  const current = steps.find((step) => step.id === "current").run;
  const download = steps.find((step) =>
    step.name?.startsWith("Download and"),
  ).run;
  const tag = "tinta-studio-v0.1.22";
  const archive = "studio-directory-0.1.22.zip";
  const bytes = zipEntries({ "index.html": Buffer.from("<p>Fixture</p>") });
  const run = (script, env = {}) =>
    spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(root, "bin") + ":" + process.env.PATH,
        RELEASE_TAG: tag,
        TINTA_RELEASE_SOURCE_SHA: source,
        STUDIO_SOURCE_SHA: source,
        GH_REPO: "fixture/tinta",
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_ENV: join(root, "environment"),
        FIXTURE_ROOT: root,
        FIXTURE_RELEASES: JSON.stringify([
          { tag_name: tag, draft: false, prerelease: false },
        ]),
        ...env,
      },
    });
  const release = (change = {}) =>
    writeFileSync(
      join(root, "release.json"),
      JSON.stringify({
        tagName: tag,
        targetCommitish: source,
        isDraft: false,
        isPrerelease: false,
        ...change,
      }),
    );
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "build"));
    writeFileSync(
      join(root, "tag.json"),
      JSON.stringify({ object: { type: "commit", sha: source } }),
    );
    writeFileSync(join(root, archive), bytes);
    writeFileSync(
      join(root, "inventory.json"),
      JSON.stringify({
        component: "studio",
        source: { dirty: false, commit: source },
        versions: { studio: "0.1.22" },
        targets: [{ id: "studio-directory", archive, sha256: digest(bytes) }],
      }),
    );
    writeFileSync(
      join(root, "bin/gh"),
      `#!/bin/sh
set -eu
case "$1 $2" in
  "release view") cat "$FIXTURE_ROOT/release.json" ;;
  "api repos/fixture/tinta/git/ref/tags/${tag}") cat "$FIXTURE_ROOT/tag.json" ;;
  "api --paginate")
    for argument in "$@"; do
      case "$argument" in --jq|--template) exit 91 ;; esac
    done
    printf '[%s]\\n' "$FIXTURE_RELEASES"
    ;;
  "attestation verify")
    test "\${FIXTURE_ATTESTATION:-valid}" = valid
    printf '%s\\n' "$@" > "$FIXTURE_ROOT/attestation-arguments"
    ;;
  "release download")
    while [ "$1" != "--pattern" ]; do shift; done
    mkdir -p "$FIXTURE_ROOT/build/demo-release"
    cp "$FIXTURE_ROOT/$2" "$FIXTURE_ROOT/build/demo-release/"
    ;;
  *) exit 90 ;;
esac
`,
      { mode: 0o755 },
    );
    for (const change of [
      { isDraft: true },
      { isPrerelease: true },
      { targetCommitish: "d".repeat(40) },
      { tagName: "different" },
    ]) {
      release(change);
      expect(run(current).status).not.toBe(0);
    }
    release();
    expect(
      run(current, {
        FIXTURE_RELEASES: JSON.stringify([
          { tag_name: tag, draft: false, prerelease: false },
          {
            tag_name: "tinta-studio-v0.2.0",
            draft: false,
            prerelease: false,
          },
        ]),
      }).status,
    ).toBe(0);
    expect(readFileSync(join(root, "output"), "utf8")).toContain(
      "publish=false",
    );
    expect(run(current).status).toBe(0);
    expect(readFileSync(join(root, "output"), "utf8")).toContain(
      "publish=true",
    );
    expect(run(current, { TINTA_RELEASE_SOURCE_SHA: "" }).status).toBe(0);
    expect(
      run(current, { RELEASE_TAG: "tinta-vscode-v0.2.22" }).status,
    ).not.toBe(0);
    expect(run(current, { RELEASE_TAG: `${tag}; invalid` }).status).not.toBe(0);
    expect(
      run(current, { TINTA_RELEASE_SOURCE_SHA: "d".repeat(40) }).status,
    ).not.toBe(0);
    expect(run(download, { FIXTURE_ATTESTATION: "invalid" }).status).not.toBe(
      0,
    );
    expect(existsSync(join(root, "build/demo-release/studio/index.html"))).toBe(
      false,
    );
    const inventoryPath = join(root, "inventory.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    for (const change of [
      { component: "language" },
      { source: { dirty: true, commit: source } },
      { source: { dirty: false, commit: "d".repeat(40) } },
      { versions: { studio: "0.1.23" } },
      { targets: [...inventory.targets, ...inventory.targets] },
      { targets: [{ ...inventory.targets[0], archive: "../outside.zip" }] },
    ]) {
      writeFileSync(inventoryPath, JSON.stringify({ ...inventory, ...change }));
      rmSync(join(root, "build/demo-release"), {
        recursive: true,
        force: true,
      });
      expect(run(download).status).not.toBe(0);
      expect(
        existsSync(join(root, "build/demo-release/studio/index.html")),
      ).toBe(false);
    }
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    writeFileSync(join(root, archive), Buffer.from("changed archive"));
    expect(run(download).status).not.toBe(0);
    expect(existsSync(join(root, "build/demo-release/studio/index.html"))).toBe(
      false,
    );
    rmSync(join(root, "build/demo-release"), { recursive: true });
    writeFileSync(join(root, archive), bytes);
    const downloaded = run(download);
    expect(downloaded.status, downloaded.stderr).toBe(0);
    expect(
      readFileSync(join(root, "build/demo-release/studio/index.html"), "utf8"),
    ).toBe("<p>Fixture</p>");
    const attestationArguments = readFileSync(
      join(root, "attestation-arguments"),
      "utf8",
    );
    for (const argument of [
      "--repo\nfixture/tinta",
      "--signer-workflow\nfixture/tinta/.github/workflows/publish-release.yml",
      `--source-digest\n${source}`,
      `--signer-digest\n${source}`,
      "--source-ref\nrefs/heads/main",
      "--deny-self-hosted-runners",
    ])
      expect(attestationArguments).toContain(argument);
    expect(
      run(steps.find((step) => step.id === "recheck").run, {
        FIXTURE_RELEASES: JSON.stringify([
          { tag_name: tag, draft: false, prerelease: false },
          {
            tag_name: "tinta-studio-v0.2.0",
            draft: false,
            prerelease: false,
          },
        ]),
      }).status,
    ).toBe(0);
    expect(
      readFileSync(join(root, "output"), "utf8")
        .trim()
        .endsWith("publish=false"),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["language", "studio", "vscode"])(
  "binds %s reports to exactly its applicable consumers",
  (component) => {
    const previous = process.env.TINTA_COMPONENT;
    try {
      process.env.TINTA_COMPONENT = component;
      const f = fixture();
      f.inventory.component = component;
      const ids = selectedTargets(config).map((target) => target.id);
      f.inventory.targets = f.inventory.targets.filter((target) =>
        ids.includes(target.id),
      );
      for (const report of f.reports) {
        report.archives = report.archives.filter((archive) =>
          ids.includes(archive.id),
        );
        if (component !== "vscode") {
          report.modes = [];
          delete report.vscode;
        } else {
          report.routes = [];
          report.browsers = [];
        }
        for (const route of report.routes)
          route.groups = [
            ...f.inventory.targets
              .filter((target) => target.archive.endsWith(".tgz"))
              .map((target) => `export:@tinta-lang/${target.id}`),
            "declarations:strict-node-next",
            "parser:budget-depth-recovery-spans",
            "engine:compile-evaluate",
            ...(component === "language"
              ? [
                  "language-service:queries",
                  "ipc:server-worker-handshake",
                  "ipc:watchdog-restart-production-worker",
                  "artifacts:installed-exports",
                ]
              : ["cli:images-grants-exports-bundle-studio"]),
          ];
      }
      expect(
        checkReports(f.inventory, producer, f.build, f.reports),
      ).toBeUndefined();
      if (component === "vscode") f.reports[0].modes.pop();
      else f.reports[0].routes[0].groups.pop();
      expect(() =>
        checkReports(f.inventory, producer, f.build, f.reports),
      ).toThrow(/Missing/);
    } finally {
      if (previous === undefined) delete process.env.TINTA_COMPONENT;
      else process.env.TINTA_COMPONENT = previous;
    }
  },
);

it.each(["language", "studio"])(
  "publishes only %s inventory targets and checks bytes before npm",
  async (component) => {
    const {
      mkdtempSync,
      mkdirSync,
      writeFileSync,
      readFileSync,
      rmSync,
      existsSync,
    } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "tinta publication fixture "));
    try {
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "build/supplied/verification"), { recursive: true });
      const group = JSON.parse(
        readFileSync("toolchain/components.json", "utf8"),
      )[component];
      const targets = config.packages
        .filter((target) => group.targets.includes(target.id))
        .map((target) => {
          const archive = `${target.id}-0.1.22.tgz`;
          const bytes = Buffer.from(`Fixture ${target.id}`);
          writeFileSync(join(root, "build/supplied", archive), bytes);
          return { id: target.id, archive, sha256: digest(bytes) };
        });
      writeFileSync(
        join(root, "build/supplied/unselected-0.1.22.tgz"),
        "Unselected payload",
      );
      writeFileSync(
        join(root, "build/supplied/verification/engine-0.1.21.tgz"),
        "Installed dependency only",
      );
      writeFileSync(
        join(root, "build/supplied/inventory.json"),
        JSON.stringify({
          targets,
          verificationPackages: [{ archive: "verification/engine-0.1.21.tgz" }],
        }),
      );
      writeFileSync(
        join(root, "bin/npm"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_ROOT/published"\n',
        { mode: 0o755 },
      );
      const workflow = parse(readFileSync(candidateWorkflow, "utf8"));
      const script = workflow.jobs.release.steps.find(
        (step) => step.name === "Publish the tested npm targets",
      ).run;
      const run = () =>
        spawnSync("bash", ["-euo", "pipefail", "-c", script], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: join(root, "bin") + ":" + process.env.PATH,
            FIXTURE_ROOT: root,
          },
        });
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(join(root, "published"), "utf8").trim().split("\n"),
      ).toEqual(
        targets.map(
          (target) =>
            `publish ${target.archive} --access public --tag latest --ignore-scripts`,
        ),
      );
      rmSync(join(root, "published"));
      writeFileSync(
        join(root, "build/supplied", targets[0].archive),
        "Changed payload",
      );
      expect(run().status).not.toBe(0);
      expect(existsSync(join(root, "published"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
