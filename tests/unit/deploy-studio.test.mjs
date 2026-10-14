import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  stableStudioRelease,
  locateStudioRelease,
  currentStudioRelease,
  prepareStudioRelease,
  verifyStudioSignature,
} from "../../scripts/deploy-studio.mjs";
import {
  fileRecord,
  candidateWorkflow,
} from "../../scripts/release-candidate.mjs";
import {
  digest,
  inspectEntries,
  zipEntries,
} from "../../scripts/distribution-archive.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function publishedReceiptFixture() {
  const repository = "fixture/tinta";
  const sourceSha = "a".repeat(40);
  const manifestSha256 = "b".repeat(64);
  const tag = "tinta-v0.1.0-vscode-0.2.0-stable";
  const releaseId = "tinta-0.1.0-vscode-0.2.0-stable";
  const calls = [];
  const release = {
    id: 21,
    tag_name: tag,
    target_commitish: sourceSha,
    draft: false,
    prerelease: false,
    published_at: "2026-10-14T06:00:00Z",
  };
  const receipt = {
    candidate: manifestSha256,
    releaseId,
    status: "promoted",
    items: {
      "github:publish": {
        status: "promoted",
        receipt: { id: 21, tag, candidate: manifestSha256, draft: false },
      },
    },
  };
  return {
    receipt,
    manifestSha256,
    sourceSha,
    repository,
    config: {
      identities: { repository: { value: repository } },
      versions: {
        implementation: "0.1.0",
        extension: "0.2.0",
        extensionChannel: "stable",
      },
      policy: { tagPrefix: "tinta-v" },
    },
    release,
    calls,
    api: async (path) => {
      calls.push(path);
      expect(path).toBe(`/repos/${repository}/releases/21`);
      return release;
    },
  };
}

it("locates the verified release by receipt ID without consulting the tag index", async () => {
  const f = publishedReceiptFixture();
  expect(await locateStudioRelease(f)).toBe(f.release);
  expect(f.calls).toEqual(["/repos/fixture/tinta/releases/21"]);
});

it.each([
  [
    "candidate",
    (f) => {
      f.receipt.candidate = "c".repeat(64);
    },
  ],
  [
    "release identity",
    (f) => {
      f.receipt.releaseId = "different";
    },
  ],
  [
    "incomplete release",
    (f) => {
      f.receipt.status = "pending";
    },
  ],
  [
    "incomplete operation",
    (f) => {
      f.receipt.items["github:publish"].status = "submitted";
    },
  ],
  [
    "published candidate",
    (f) => {
      f.receipt.items["github:publish"].receipt.candidate = "c".repeat(64);
    },
  ],
  [
    "published tag",
    (f) => {
      f.receipt.items["github:publish"].receipt.tag = "different";
    },
  ],
  [
    "published draft",
    (f) => {
      f.receipt.items["github:publish"].receipt.draft = true;
    },
  ],
  [
    "invalid ID",
    (f) => {
      f.receipt.items["github:publish"].receipt.id = -1;
    },
  ],
  [
    "remote source",
    (f) => {
      f.release.target_commitish = "c".repeat(40);
    },
  ],
  [
    "remote tag",
    (f) => {
      f.release.tag_name = "different";
    },
  ],
  [
    "remote ID",
    (f) => {
      f.release.id = 22;
    },
  ],
  [
    "remote draft",
    (f) => {
      f.release.draft = true;
    },
  ],
  [
    "remote prerelease",
    (f) => {
      f.release.prerelease = true;
    },
  ],
])(
  "rejects an inconsistent %s during the Studio handoff",
  async (_name, change) => {
    const f = publishedReceiptFixture();
    change(f);
    await expect(locateStudioRelease(f)).rejects.toThrow();
  },
);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tinta-release-demo-"));
  directories.push(directory);
  const source = "a".repeat(40);
  const release = {
    id: 21,
    draft: false,
    prerelease: false,
    published_at: "2026-10-13T12:00:00Z",
    tag_name: "tinta-v0.1.0-vscode-0.2.0-stable",
  };
  const producer = {
    repository: "fixture/tinta",
    repositoryId: "42",
    workflow: candidateWorkflow,
    workflowSha: source,
    sourceSha: source,
    sourceTree: "b".repeat(40),
    event: "push",
    runId: "77",
    attempt: 2,
    ref: "refs/heads/main",
  };
  const entries = {
    "index.html": Buffer.from("<h1>tinta studio</h1>"),
    "assets/studio.js": Buffer.from("console.log('studio');"),
    LICENSE: Buffer.from("License text. ".repeat(20)),
    "THIRD_PARTY_NOTICES.txt": Buffer.from("Third party notices. ".repeat(20)),
  };
  const archiveName = "studio-directory-0.1.0.zip";
  const bytes = Buffer.from(zipEntries(entries));
  const archive = fileRecord(archiveName, bytes);
  const versions = {
    implementation: "0.1.0",
    extension: "0.2.0",
    npmChannel: "latest",
    extensionChannel: "stable",
  };
  const manifest = {
    schemaVersion: 1,
    tag: release.tag_name,
    source: { commit: source },
    versions,
    targets: [
      {
        id: "studio-directory",
        kind: "zip",
        version: "0.1.0",
        channel: "latest",
        archive,
      },
    ],
  };
  const inventory = {
    versions,
    source: { commit: source, dirty: false },
    targets: [
      {
        id: "studio-directory",
        archive: archiveName,
        sha256: archive.sha256,
        files: inspectEntries(entries, Object.keys(entries)),
      },
    ],
  };
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const buffers = new Map([
    [archiveName, bytes],
    ["release-manifest.json", encode(manifest)],
    ["inventory.json", encode(inventory)],
    ["attestation.sigstore.json", Buffer.from("signature fixture")],
  ]);
  buffers.set(
    "candidate-index.json",
    encode({
      format: "tinta-candidate-1",
      producer,
      manifest: fileRecord(
        "release-manifest.json",
        buffers.get("release-manifest.json"),
      ),
      inventory: fileRecord("inventory.json", buffers.get("inventory.json")),
    }),
  );
  const assets = [...buffers.keys()].map((name, index) => ({
    id: index + 1,
    name,
  }));
  const releases = [release];
  const tag = { object: { type: "commit", sha: source } };
  const run = {
    id: 77,
    run_attempt: 2,
    head_sha: source,
    path: candidateWorkflow,
    repository: { id: 42 },
    status: "completed",
    conclusion: "success",
  };
  const api = async (path) => {
    if (path.endsWith("/releases/21/assets?per_page=100"))
      return assets.map((asset) => {
        const value = buffers.get(asset.name);
        return {
          ...asset,
          size: value.length,
          digest: `sha256:${digest(value)}`,
          state: "uploaded",
        };
      });
    if (path.includes("/releases?")) return releases;
    if (path.includes("/git/ref/")) return tag;
    if (path.includes("/actions/runs/")) return run;
    return { full_name: producer.repository, id: 42, default_branch: "main" };
  };
  const signatures = [];
  return {
    directory,
    release,
    repository: producer.repository,
    repositoryId: "42",
    api,
    producer,
    buffers,
    assets,
    releases,
    tag,
    run,
    entries,
    signatures,
    download: async (id) =>
      buffers.get(assets.find((asset) => asset.id === id).name),
    attest: async (...args) => {
      signatures.push(args);
    },
  };
}

describe("published Studio deployment", () => {
  it("extracts exactly the signed release bytes without rebuilding", async () => {
    const f = fixture();
    const receipt = await prepareStudioRelease(f);
    expect(receipt.releaseId).toBe(21);
    expect(receipt.sourceSha).toBe(f.producer.sourceSha);
    expect(f.signatures).toHaveLength(1);
    expect(f.signatures[0][1]).toEqual(f.producer);
    for (const [name, bytes] of Object.entries(f.entries))
      expect(readFileSync(join(receipt.output, name))).toEqual(bytes);
  });

  it.each([
    [
      "draft",
      (f) => {
        f.release.draft = true;
      },
    ],
    [
      "prerelease",
      (f) => {
        f.release.prerelease = true;
      },
    ],
    [
      "unpublished",
      (f) => {
        f.release.published_at = null;
      },
    ],
    [
      "odd extension minor",
      (f) => {
        f.release.tag_name = "tinta-v0.1.0-vscode-0.1.0-stable";
      },
    ],
    [
      "tag source mismatch",
      (f) => {
        f.tag.object.sha = "c".repeat(40);
      },
    ],
    [
      "failed producer",
      (f) => {
        f.run.conclusion = "failure";
      },
    ],
    [
      "different attempt",
      (f) => {
        f.run.run_attempt = 1;
      },
    ],
    [
      "different producer workflow",
      (f) => {
        f.run.path = ".github/workflows/unrelated.yml";
      },
    ],
    [
      "missing archive",
      (f) => {
        f.assets.splice(0, 1);
      },
    ],
    [
      "duplicate metadata",
      (f) => {
        f.assets.push({ ...f.assets.at(-1) });
      },
    ],
    [
      "changed archive",
      (f) => {
        f.buffers.set("studio-directory-0.1.0.zip", Buffer.from("changed"));
      },
    ],
    [
      "changed manifest",
      (f) => {
        f.buffers.set("release-manifest.json", Buffer.from("{}"));
      },
    ],
    [
      "changed inventory",
      (f) => {
        f.buffers.set("inventory.json", Buffer.from("{}"));
      },
    ],
  ])("rejects %s before writing Studio files", async (_name, change) => {
    const f = fixture();
    change(f);
    await expect(prepareStudioRelease(f)).rejects.toThrow();
    expect(existsSync(join(f.directory, "studio"))).toBe(false);
  });

  it("requires cryptographic verification before reading the manifest", async () => {
    const f = fixture();
    f.attest = async () => {
      throw new Error("Invalid signature");
    };
    await expect(prepareStudioRelease(f)).rejects.toThrow(/Invalid signature/);
    expect(existsSync(join(f.directory, "studio"))).toBe(false);
  });

  it("does not replace a newer stable demo or promote a prerelease", async () => {
    const f = fixture();
    f.releases.push({
      ...f.release,
      id: 22,
      tag_name: "tinta-v0.2.0-vscode-0.4.0-stable",
    });
    expect(await prepareStudioRelease(f)).toBeNull();
    expect(f.signatures).toHaveLength(0);
    f.releases[1].prerelease = true;
    expect(await currentStudioRelease(f.release, f.repository, f.api)).toBe(
      true,
    );
  });

  it("verifies the release signature bundle with exact producer constraints", () => {
    const f = fixture();
    const commands = [];
    verifyStudioSignature(
      "index.json",
      f.producer,
      "bundle.json",
      (command) => {
        commands.push(command);
        if (command[1] === "--version")
          return { stdout: "gh version 2.102.0 fixture" };
        return {
          stdout: JSON.stringify([
            {
              verificationResult: {
                statement: {
                  predicate: {
                    runDetails: {
                      metadata: {
                        invocationId:
                          "https://github.com/fixture/tinta/actions/runs/77/attempts/2",
                      },
                    },
                  },
                },
              },
            },
          ]),
        };
      },
    );
    expect(commands[1].slice(-2)).toEqual(["--bundle", "bundle.json"]);
    expect(commands[1]).toContain("--source-digest");
    expect(commands[1]).toContain(f.producer.sourceSha);
    expect(commands[1]).toContain("--signer-digest");
  });

  it("deploys the published release inside CD without build or test steps", () => {
    const workflow = parse(
      readFileSync(".github/workflows/publish-release.yml", "utf8"),
    );
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.jobs["prepare-studio"].needs).toBe("publish");
    expect(workflow.jobs["deploy-studio"].needs).toEqual([
      "publish",
      "prepare-studio",
    ]);
    expect(workflow.concurrency).toEqual({
      group: "publication",
      "cancel-in-progress": false,
      queue: "max",
    });
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(
        /pnpm build|playwright|vitest|pnpm verify/,
      );
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    expect(
      steps.find((step) =>
        step.uses?.startsWith("actions/upload-pages-artifact@"),
      ).with.path,
    ).toBe("build/demo-release/studio/");
    const publisher = parse(
      readFileSync(".github/workflows/publish-release.yml", "utf8"),
    );
    const publishSteps = publisher.jobs.publish.steps;
    const publication = publishSteps.findIndex(
      (step) => step.run === "node scripts/publish-release.mjs all",
    );
    const dispatch = publishSteps.findIndex(
      (step) => step.run === "node scripts/deploy-studio.mjs locate",
    );
    expect(dispatch).toBeGreaterThan(publication);
    expect(publisher.jobs.publish.permissions.actions).toBe("read");
    expect(stableStudioRelease(fixture().release)).toEqual({
      implementation: "0.1.0",
      extension: "0.2.0",
    });
  });
});
