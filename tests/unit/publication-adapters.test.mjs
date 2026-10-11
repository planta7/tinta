import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fileRecord } from "../../scripts/release-candidate.mjs";
import { zipEntries, digest } from "../../scripts/distribution-archive.mjs";
import {
  marketplaceAdapter,
  verifyMarketplacePayload,
} from "../../scripts/publication-marketplace.mjs";
import { npmAdapter, npmRunner } from "../../scripts/publication-npm.mjs";
import { releaseAdapter } from "../../scripts/publication-github.mjs";
import {
  httpTransport,
  entraCredential,
} from "../../scripts/publication-transport.mjs";
import {
  dispatchInputs,
  activationPolicy,
} from "../../scripts/publication-gate.mjs";
import { loadReleaseConfig } from "../../scripts/release-contract.mjs";
import { acquireCandidate } from "../../scripts/publish-release.mjs";

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "publication-adapter-"));
  const bytes = Buffer.from(
    zipEntries({
      "extension/package.json": Buffer.from(
        '{"publisher":"fixture","name":"extension","version":"0.1.0"}',
      ),
      "extension/code.js": Buffer.from("export const value = 1;"),
    }),
  );
  writeFileSync(join(directory, "fixture.vsix"), bytes);
  return {
    directory,
    bytes,
    archive: fileRecord("fixture.vsix", bytes),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: "a".repeat(40),
  TINTA_REVIEWED_PUBLISHER_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "fixture/repo",
  GITHUB_REPOSITORY_ID: "42",
  GITHUB_REF: "refs/heads/main",
  RUNNER_ENVIRONMENT: "github-hosted",
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://fixture.actions.githubusercontent.com/token?existing=yes",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-value",
  TINTA_DEFAULT_BRANCH: "main",
  TINTA_CANDIDATE_RUN: "123",
  TINTA_CANDIDATE_ATTEMPT: "1",
  TINTA_MANIFEST_SHA256: "b".repeat(64),
};

describe("credential and dispatch boundaries", () => {
  it("binds GitHub OIDC audience to the Entra client assertion flow", async () => {
    const calls = [];
    const result = await entraCredential(
      async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
          ? { value: "fixture-assertion" }
          : {
              access_token: "fixture-access",
              token_type: "Bearer",
              expires_in: 3600,
            };
      },
      env,
      { tenant: "a".repeat(36), client: "b".repeat(36) },
    );
    expect(result).toBe("fixture-access");
    expect(new URL(calls[0].url).searchParams.get("audience")).toBe(
      "api://AzureADTokenExchange",
    );
    const body = new URLSearchParams(calls[1].options.body);
    expect(body.get("scope")).toBe(
      "499b84ac-1321-427f-aa17-267ca6975798/.default",
    );
    expect(body.get("client_assertion")).toBe("fixture-assertion");
    expect(body.has("client_secret")).toBe(false);
  });
  it("rejects expired credentials and other providers", async () => {
    const binding = { tenant: "a".repeat(36), client: "b".repeat(36) };
    await expect(
      entraCredential(
        async () => ({
          value: "fixture",
          access_token: "fixture",
          token_type: "Bearer",
          expires_in: 1,
        }),
        env,
        binding,
      ),
    ).rejects.toThrow("Expired");
    await expect(
      entraCredential(
        async () => {
          throw new Error("Should not request");
        },
        { ...env, RUNNER_ENVIRONMENT: "self-hosted" },
        binding,
      ),
    ).rejects.toThrow();
  });
  it("strips ambient credentials and disables lifecycle scripts in npm subprocesses", () => {
    const calls = [];
    const runner = npmRunner(
      "/fixture/npm-cli.js",
      {
        ...env,
        NODE_AUTH_TOKEN: "must-not-inherit",
        NPM_TOKEN: "must-not-inherit",
        NODE_OPTIONS: "must-not-inherit",
      },
      (command, args, options) => {
        calls.push({ command, args, options });
        return {
          status: 0,
          stdout: args.includes("--version") ? "11.21.0\n" : "",
        };
      },
    );
    runner.run(["publish", "fixture.tgz"], true);
    runner.run(["install", "--ignore-scripts"]);
    for (const call of calls) {
      expect(call.options.shell).toBe(false);
      expect(call.options.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(call.options.env.NPM_TOKEN).toBeUndefined();
      expect(call.options.env.NODE_OPTIONS).toBeUndefined();
      expect(call.options.env.npm_config_ignore_scripts).toBe("true");
      expect(call.options.env.npm_config_fetch_retries).toBe("0");
    }
    expect(
      calls.at(-1).options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    ).toBeUndefined();
  });
  it("rejects tool versions without OIDC dist-tag support", () => {
    expect(() =>
      npmRunner("/fixture/npm-cli.js", env, () => ({
        status: 0,
        stdout: "11.19.0",
      })),
    ).toThrow();
  });
  it("rejects shell text, wrong branch and oversized attempt", () => {
    expect(dispatchInputs(env).attempt).toBe(1);
    for (const patch of [
      { TINTA_CANDIDATE_RUN: "123; run" },
      { TINTA_MANIFEST_SHA256: "arbitrary-url" },
      { GITHUB_REF: "refs/heads/other" },
      { TINTA_CANDIDATE_ATTEMPT: "99999999999999999" },
    ]) {
      expect(() => dispatchInputs({ ...env, ...patch })).toThrow();
    }
  });
  it("rejects disabled policies and requires every activation binding", () => {
    const policy = JSON.parse(readFileSync("toolchain/publication.json"));
    const config = loadReleaseConfig();
    policy.enabled = false;
    config.policy.externalActivation = false;
    for (const key of [
      "publishPermission",
      "distTagPermission",
      "bootstrapComplete",
    ]) {
      policy.npm[key] = false;
    }
    expect(() => activationPolicy(policy, config, env)).toThrow("disabled");
    policy.enabled = true;
    expect(() => activationPolicy(policy, config, env)).toThrow("disabled");
    config.policy.externalActivation = true;
    policy.repository = env.GITHUB_REPOSITORY;
    policy.repositoryId = env.GITHUB_REPOSITORY_ID;
    policy.publisherSha = env.GITHUB_SHA;
    config.identities.repository.value = policy.repository;
    for (const key of [
      "publishPermission",
      "distTagPermission",
      "bootstrapComplete",
    ]) {
      expect(() => activationPolicy(policy, config, env)).toThrow();
      policy.npm[key] = true;
    }
    policy.marketplace.githubFederationVerified = false;
    expect(() => activationPolicy(policy, config, env)).toThrow("unverified");
  });
  it("redacts service error bodies and disallows HTTP redirects", async () => {
    const calls = [];
    const request = httpTransport(async (url, options) => {
      calls.push(options);
      return new Response("sensitive response", { status: 401 });
    });
    await expect(request("https://fixture.invalid")).rejects.toThrow("401");
    await expect(request("https://fixture.invalid")).rejects.not.toThrow(
      "sensitive",
    );
    expect(calls[0].redirect).toBe("error");
  });
});

describe("npm destination", () => {
  it("uploads only the verified archive with explicit candidate tag and public access", async () => {
    const w = workspace();
    try {
      const target = {
        name: "@fixture/package",
        version: "1.0.0",
        kind: "npm",
        channel: "latest",
        archive: w.archive,
        dependencies: [],
        externalDependencies: {},
      };
      const commands = [];
      const meta = {
        name: target.name,
        version: target.version,
        dependencies: {},
        dist: {
          integrity: w.archive.integrity,
          tarball: "https://registry.npmjs.org/fixture.tgz",
        },
      };
      const request = async (_url, options) =>
        options?.binary
          ? w.bytes
          : { versions: { "1.0.0": meta }, "dist-tags": { latest: "0.9.0" } };
      const adapter = npmAdapter({
        request,
        directory: w.directory,
        runner: { run: (...args) => commands.push(args) },
      });
      const op = adapter.upload(target, { candidate: "a".repeat(64) });
      await op.write();
      expect(commands[0][0]).toContain("public");
      expect(commands[0][0]).toContain(`candidate-${"a".repeat(64)}`);
      expect(commands[0][0]).not.toContain("latest");
      expect((await op.verify(await op.read())).sha256).toBe(w.archive.sha256);
      meta.dist.integrity = "different";
      await expect(op.verify(meta)).rejects.toThrow("collision");
      meta.dist.integrity = w.archive.integrity;
      meta.dist.tarball = "https://other.invalid/archive";
      await expect(op.verify(meta)).rejects.toThrow("origin");
      writeFileSync(join(w.directory, "fixture.vsix"), "tampered");
      await expect(op.write()).rejects.toThrow("Changed file");
      expect(commands).toHaveLength(1);
    } finally {
      w.close();
    }
  });
  it("rejects changed channels and production-like registry overrides", async () => {
    const adapter = npmAdapter({
      request: async () => ({ "dist-tags": { latest: "2.0.0" } }),
      runner: {},
      directory: ".",
    });
    const target = {
      name: "@fixture/package",
      channel: "latest",
      version: "1.0.0",
    };
    await expect(adapter.promote(target, "0.9.0").write()).rejects.toThrow(
      "concurrently",
    );
    expect(() =>
      npmAdapter({ registry: "https://registry.npmjs.org.evil.invalid" }),
    ).toThrow();
  });
  it("blocks missing package bootstrap instead of falling back to a token", async () => {
    const adapter = npmAdapter({
      request: async () => null,
      runner: {},
      directory: ".",
    });
    await expect(
      adapter.preflight({
        targets: [{ kind: "npm", name: "@fixture/package" }],
      }),
    ).rejects.toThrow("bootstrap");
  });
});

describe("Marketplace destination", () => {
  it("compares payload files when signing changes container bytes", () => {
    const w = workspace();
    try {
      const changed = zipEntries({
        "extension/package.json": Buffer.from(
          '{"publisher":"fixture","name":"extension","version":"0.1.0"}',
        ),
        "extension/code.js": Buffer.from("export const value = 1;"),
        ".signature.p7s": Buffer.from("fixture-signature"),
      });
      expect(verifyMarketplacePayload(w.bytes, changed).byteIdentical).toBe(
        false,
      );
      expect(() =>
        verifyMarketplacePayload(
          w.bytes,
          zipEntries({ "extra.js": Buffer.from("extra") }),
        ),
      ).toThrow();
    } finally {
      w.close();
    }
  });
  it("uses Entra, preserves exact uploaded bytes, and records publisher/version/channel", async () => {
    const w = workspace();
    try {
      const calls = [];
      let uploaded = false;
      const publisherId = "fixture-publisher-id";
      const remote = {
        extensionName: "extension",
        extensionId: "fixture-extension-id",
        publisher: { publisherName: "fixture", publisherId },
        versions: [
          {
            version: "0.1.0",
            properties: [
              { key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" },
            ],
          },
        ],
      };
      const request = async (url, options) => {
        calls.push({ url, options });
        if (options.method === "POST") {
          uploaded = true;
          return remote;
        }
        if (options.binary) return w.bytes;
        if (url.includes("/extensions/")) return uploaded ? remote : null;
        return { publisherId, publisherName: "fixture" };
      };
      const adapter = marketplaceAdapter({
        request,
        credential: async () => "fixture-access",
        directory: w.directory,
        publisherId,
      });
      const target = {
        kind: "vsix",
        name: "fixture.extension",
        version: "0.1.0",
        channel: "pre-release",
        archive: w.archive,
      };
      await adapter.preflight({ targets: [target] });
      const op = adapter.upload(target);
      await op.write();
      const submitted = calls.find((call) => call.options.method === "POST");
      expect(submitted.options.body).toEqual(w.bytes);
      expect(submitted.options.headers.Authorization).toBe(
        "Bearer fixture-access",
      );
      const receipt = await op.verify(await op.read());
      expect(receipt).toMatchObject({
        publisher: "fixture",
        publisherId,
        version: "0.1.0",
        channel: "pre-release",
        targetPlatform: "universal",
        submittedSha256: w.archive.sha256,
      });
      expect(JSON.stringify(receipt)).not.toContain("fixture-access");
      await expect(op.write()).rejects.toThrow("already exists");
      target.channel = "stable";
      await expect(op.verify(await op.read())).rejects.toThrow("channel");
    } finally {
      w.close();
    }
  });
});

it("uploads immutable GitHub assets, detects collisions and finalizes only the full set", async () => {
  const w = workspace();
  try {
    const plan = {
      repository: "fixture/repo",
      tag: "fixture-tag",
      sourceSha: "a".repeat(40),
      candidate: w.archive.sha256,
      releaseId: "fixture-release",
      targets: [{ kind: "npm", channel: "next", archive: w.archive }],
      metadata: [],
    };
    let tag = null;
    let release = null;
    const assets = [];
    const mutations = [];
    const api = async (method, path, body) => {
      if (method !== "GET") mutations.push({ method, path, body });
      if (path.endsWith("/fixture/repo"))
        return {
          full_name: plan.repository,
          private: false,
          permissions: { push: true },
        };
      if (path.includes("/git/ref/")) return tag;
      if (path.endsWith("/git/refs")) {
        tag = { object: { type: "commit", sha: body.sha } };
        return tag;
      }
      if (path.includes("/releases/tags/")) return release;
      if (path.includes("/assets?")) return assets;
      if (method === "POST") {
        release = { ...body, id: 1 };
        return release;
      }
      if (method === "PATCH") {
        release = { ...release, ...body };
        return release;
      }
      throw new Error("Unexpected fixture operation");
    };
    const request = async (_url, options) => {
      expect(options.body).toEqual(w.bytes);
      assets.push({
        id: 2,
        name: "fixture.vsix",
        state: "uploaded",
        size: w.bytes.length,
        digest: `sha256:${digest(options.body)}`,
      });
    };
    const adapter = releaseAdapter({
      api,
      request,
      token: "fixture-token",
      directory: w.directory,
    });
    await adapter.preflight(plan);
    for await (const op of adapter.operations(plan)) {
      if (!(await op.read())) await op.write();
      await op.verify(await op.read());
    }
    expect(release.draft).toBe(false);
    expect(mutations.at(-1).body).toEqual({
      draft: false,
      make_latest: "false",
    });
    assets[0].digest = `sha256:${"0".repeat(64)}`;
    for await (const op of adapter.operations(plan)) {
      if (op.key.startsWith("asset:"))
        await expect(op.verify(await op.read())).rejects.toThrow("collision");
    }
    tag.object.sha = "b".repeat(40);
    await expect(adapter.preflight(plan)).rejects.toThrow("tag collision");
  } finally {
    w.close();
  }
});

it("selects candidate storage by run/attempt and authenticates container bytes", async () => {
  const bytes = Buffer.from("fixture-container");
  const run = {
    id: 123,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/release-candidate.yml",
    event: "workflow_dispatch",
    head_sha: "a".repeat(40),
    repository: { full_name: "fixture/repo" },
  };
  const api = async (_method, path) => {
    if (path.endsWith("/fixture/repo"))
      return { id: 42, default_branch: "main" };
    if (path.includes("/attempts/")) return run;
    if (path.includes("/git/commits/"))
      return { tree: { sha: "b".repeat(40) } };
    return {
      total_count: 1,
      artifacts: [
        {
          id: 8,
          name: "candidate-123-1",
          digest: `sha256:${digest(bytes)}`,
          expired: false,
        },
      ],
    };
  };
  const inputs = dispatchInputs(env);
  const value = await acquireCandidate(
    api,
    inputs,
    "fixture/repo",
    async () => bytes,
  );
  expect(value.expected.producer.sourceSha).toBe(run.head_sha);
  await expect(
    acquireCandidate(api, inputs, "fixture/repo", async () =>
      Buffer.from("tampered"),
    ),
  ).rejects.toThrow("digest");
  run.conclusion = "failure";
  await expect(
    acquireCandidate(api, inputs, "fixture/repo", async () => bytes),
  ).rejects.toThrow();
});

it("keeps publish workflow gated, serialized, pinned and free of candidate builds", () => {
  const text = readFileSync(".github/workflows/publish-release.yml", "utf8");
  const workflow = parse(text);
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
    "candidate_run",
    "candidate_attempt",
    "manifest_sha256",
  ]);
  expect(workflow.permissions).toEqual({});
  expect(workflow.concurrency).toEqual({
    group: "publication",
    "cancel-in-progress": false,
  });
  const gate = workflow.jobs["candidate-gate"];
  const publish = workflow.jobs.publish;
  expect(gate.permissions["id-token"]).toBeUndefined();
  expect(gate.permissions.contents).toBe("read");
  expect(publish.needs).toBe("candidate-gate");
  expect(publish.environment).toBe("release");
  const pins = JSON.parse(readFileSync("toolchain/actions.json")).map(
    (pin) => pin.commit,
  );
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps) {
      if (step.uses) expect(pins).toContain(step.uses.split("@")[1]);
      if (step.run) expect(step.run).not.toContain("${{ inputs.");
    }
  const publication = publish.steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join("\n");
  expect(publication).not.toMatch(
    /npm install|pnpm install|pnpm build|package:vscode|distribution-package/,
  );
  expect(publication).toContain("publish-release.mjs npm");
  expect(publication).toContain("publish-release.mjs marketplace");
  expect(publication).toContain("publish-release.mjs promote");
  expect(publication).toContain("publish-release.mjs github");
  expect(text).not.toContain("secrets.");
});
