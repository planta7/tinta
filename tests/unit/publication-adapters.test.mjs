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
import {
  releaseAdapter,
  candidateReleaseNotes,
} from "../../scripts/publication-github.mjs";
import {
  httpTransport,
  entraCredential,
} from "../../scripts/publication-transport.mjs";
import {
  dispatchInputs as parseDispatchInputs,
  activationPolicy,
} from "../../scripts/publication-gate.mjs";
import { loadReleaseConfig } from "../../scripts/release-contract.mjs";
import {
  acquireCandidate,
  publicationFailure,
} from "../../scripts/publish-release.mjs";

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "publication-adapter-"));
  const bytes = Buffer.from(
    zipEntries({
      "extension/package.json": Buffer.from(
        '{"publisher":"fixture","name":"extension","version":"0.1.0"}',
      ),
      "extension/code.js": Buffer.from("export const value = 1;"),
      "extension.vsixmanifest": Buffer.from(
        '<Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/></Properties>',
      ),
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
  GITHUB_EVENT_NAME: "workflow_run",
  GITHUB_SHA: "a".repeat(40),
  TINTA_RELEASE_SOURCE_SHA: "a".repeat(40),
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

const sourceEvent = {
  workflow_run: {
    id: 123,
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/verify.yml",
    head_branch: "main",
    head_sha: "a".repeat(40),
    head_repository: { full_name: "fixture/repo", id: 42 },
  },
};
const dispatchInputs = (value) => parseDispatchInputs(value, sourceEvent);

describe("credential and dispatch boundaries", () => {
  it("reports failure locations without assertion values, tokens or private paths", () => {
    const error = new Error("Bearer fixture-secret; expected fixture-secret");
    error.code = "ERR_ASSERTION";
    error.stack +=
      "\n    at preflight (file:///private/work/scripts/publication-github.mjs:35:14)";
    expect(publicationFailure(error)).toBe(
      "ERR_ASSERTION at publication-github.mjs:35:14",
    );
    expect(
      publicationFailure({ code: "fixture-secret", stack: "fixture-secret" }),
    ).toBe("OPERATION_FAILED");
    expect(publicationFailure(null)).toBe("OPERATION_FAILED");
  });

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
  it.each([408, 429, 500, 502, 503, 504, "network"])(
    "retries a transient %s read without replaying writes",
    async (failure) => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        let calls = 0;
        const waits = [];
        const request = httpTransport(
          async () => {
            calls += 1;
            if (calls === 1) {
              if (failure === "network") throw new TypeError("Connection lost");
              return new Response(null, { status: failure });
            }
            return Response.json({ verified: true });
          },
          { wait: async (ms) => waits.push(ms) },
        );
        const result = request("https://fixture.invalid", { method });
        if (method === "GET") {
          await expect(result).resolves.toEqual({ verified: true });
          expect(calls).toBe(2);
          expect(waits).toEqual([1000]);
        } else {
          await expect(result).rejects.toThrow();
          expect(calls).toBe(1);
          expect(waits).toEqual([]);
        }
      }
    },
  );
  it.each([401, 403, 404, 502])(
    "bounds unsuccessful %s reads",
    async (status) => {
      let calls = 0;
      const waits = [];
      const request = httpTransport(
        async () => {
          calls += 1;
          return new Response("sensitive", { status });
        },
        { wait: async (ms) => waits.push(ms) },
      );
      await expect(request("https://fixture.invalid")).rejects.not.toThrow(
        "sensitive",
      );
      expect(calls).toBe(status === 502 ? 3 : 1);
      expect(waits).toEqual(status === 502 ? [1000, 2000] : []);
    },
  );
});

describe("npm destination", () => {
  it("verifies an uploaded version while the aggregate package index remains stale", async () => {
    const w = workspace();
    try {
      const target = {
        name: "@fixture/package",
        version: "1.0.0",
        kind: "npm",
        archive: w.archive,
        dependencies: [],
        externalDependencies: {},
      };
      const remote = {
        name: target.name,
        version: target.version,
        dist: {
          integrity: w.archive.integrity,
          tarball: "https://registry.npmjs.org/fixture.tgz",
        },
      };
      let writes = 0;
      let aggregateReads = 0;
      const adapter = npmAdapter({
        directory: w.directory,
        runner: {
          run: () => {
            writes += 1;
          },
        },
        request: async (url, options) => {
          if (options?.binary) return w.bytes;
          if (url.endsWith("/1.0.0")) return writes ? remote : null;
          aggregateReads += 1;
          return { name: target.name, versions: {} };
        },
        wait: async () => {},
      });
      await adapter.preflight({ targets: [target] });
      const operation = adapter.upload(target, { candidate: "a".repeat(64) });
      expect(await operation.read()).toBeNull();
      await operation.write();
      expect((await operation.verify(await operation.read())).sha256).toBe(
        w.archive.sha256,
      );
      expect(await operation.read()).toEqual(remote);
      expect(aggregateReads).toBe(1);
      expect(writes).toBe(1);
    } finally {
      w.close();
    }
  });

  it.each([20000, 300000, 900000, null])(
    "waits for uploaded version availability without repeating the upload: %s ms",
    async (visibleAfterMs) => {
      const w = workspace();
      try {
        let writes = 0;
        let reads = 0;
        let waits = 0;
        let elapsed = 0;
        const target = {
          name: "@fixture/package",
          version: "1.0.0",
          archive: w.archive,
        };
        const metadata = { name: target.name, version: target.version };
        const operation = npmAdapter({
          directory: w.directory,
          runner: {
            run: () => {
              writes += 1;
            },
          },
          request: async (url, options) => {
            expect(url).toBe(
              "https://registry.npmjs.org/%40fixture%2Fpackage/1.0.0",
            );
            expect(options.missing).toBe(true);
            expect(options.headers["Cache-Control"]).toBe("no-cache");
            if (!writes) return null;
            reads += 1;
            return visibleAfterMs !== null && elapsed >= visibleAfterMs
              ? metadata
              : null;
          },
          now: () => elapsed,
          wait: async (ms) => {
            expect(ms).toBe(10000);
            waits += 1;
            elapsed += ms;
          },
        }).upload(target, { candidate: "a".repeat(64) });
        expect(await operation.read()).toBeNull();
        expect(waits).toBe(0);
        await operation.write();
        expect(await operation.read()).toEqual(
          visibleAfterMs === null ? null : metadata,
        );
        expect(writes).toBe(1);
        const expectedWaits = (visibleAfterMs ?? 20 * 60 * 1000) / 10000;
        expect(reads).toBe(expectedWaits + 1);
        expect(waits).toBe(expectedWaits);
        expect(operation.retryAbsent).not.toBe(true);
      } finally {
        rmSync(w.directory, { recursive: true, force: true });
      }
    },
  );

  it("waits for a recorded npm submission on resume without sending it again", async () => {
    let elapsed = 0;
    let writes = 0;
    const metadata = { name: "@fixture/package", version: "1.0.0" };
    const operation = npmAdapter({
      directory: ".",
      runner: {
        run: () => {
          writes += 1;
        },
      },
      request: async () => (elapsed >= 300000 ? metadata : null),
      now: () => elapsed,
      wait: async (ms) => {
        elapsed += ms;
      },
    }).upload(metadata, {});
    expect(await operation.read({ pending: true })).toEqual(metadata);
    expect(elapsed).toBe(300000);
    expect(writes).toBe(0);
    expect(operation.retryAbsent).not.toBe(true);
  });

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
        options?.binary ? w.bytes : meta;
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
      request: async () => ({ latest: "2.0.0" }),
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
  it("reads channel changes from the tag endpoint instead of cached package metadata", async () => {
    const target = {
      name: "@fixture/package",
      version: "0.1.0-dev.0",
      channel: "next",
    };
    const tags = {};
    const requests = [];
    const adapter = npmAdapter({
      directory: ".",
      request: async (url, options) => {
        requests.push(url);
        if (url.endsWith("/dist-tags")) {
          expect(options.headers["Cache-Control"]).toBe("no-cache");
          return { ...tags };
        }
        return { "dist-tags": {} };
      },
      runner: {
        run(args) {
          expect(args.slice(0, 4)).toEqual([
            "dist-tag",
            "add",
            "@fixture/package@0.1.0-dev.0",
            "next",
          ]);
          tags.next = target.version;
        },
      },
    });
    expect(await adapter.channel(target)).toBeNull();
    const operation = adapter.promote(target, null);
    await operation.write();
    expect(await operation.read()).toBe(target.version);
    await operation.verify(await operation.read());
    expect(await adapter.channel(target)).toBe(target.version);
    expect(
      requests.every(
        (url) =>
          url ===
          "https://registry.npmjs.org/-/package/%40fixture%2Fpackage/dist-tags",
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    "bounds delayed channel visibility without repeating writes: %s",
    async (neverVisible) => {
      let written = false;
      let readsAfterWrite = 0;
      let writes = 0;
      let waits = 0;
      const target = {
        name: "@fixture/package",
        version: "0.1.0-dev.0",
        channel: "next",
      };
      const adapter = npmAdapter({
        directory: ".",
        request: async () => {
          if (!written) return {};
          readsAfterWrite += 1;
          return !neverVisible && readsAfterWrite >= 3
            ? { next: target.version }
            : {};
        },
        runner: {
          run() {
            written = true;
            writes += 1;
          },
        },
        wait: async (milliseconds) => {
          expect(milliseconds).toBe(5000);
          waits += 1;
        },
      });
      const operation = adapter.promote(target, null);
      expect(await operation.read()).toBeNull();
      expect(waits).toBe(0);
      await operation.write();
      expect(await operation.read()).toBe(neverVisible ? null : target.version);
      expect(writes).toBe(1);
      expect(readsAfterWrite).toBe(neverVisible ? 13 : 3);
      expect(waits).toBe(neverVisible ? 12 : 2);
    },
  );
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
  it.each([null, "0.1.0-dev.0"])(
    "removes an unintended stable tag before completing prerelease promotion from %s",
    async (previous) => {
      const target = {
        name: "@fixture/package",
        channel: "next",
        version: "0.1.0-dev.0",
      };
      const tags = { latest: target.version };
      if (previous) tags.next = previous;
      const commands = [];
      const adapter = npmAdapter({
        directory: ".",
        request: async () => ({ ...tags }),
        runner: {
          run(args, authenticated) {
            expect(authenticated).toBe(true);
            commands.push(args);
            if (args[1] === "rm") delete tags.latest;
            else tags.next = target.version;
          },
        },
      });
      const operation = adapter.promote(target, previous);
      expect(await operation.read()).toBeNull();
      await expect(operation.verify(target.version)).rejects.toThrow(
        "stable channel",
      );
      await operation.write();
      expect(tags).toEqual({ next: target.version });
      expect(commands[0].slice(0, 4)).toEqual([
        "dist-tag",
        "rm",
        target.name,
        "latest",
      ]);
      expect(commands).toHaveLength(previous ? 1 : 2);
      expect(await operation.read()).toBe(target.version);
      expect((await operation.verify(await operation.read())).new).toBe(
        target.version,
      );
    },
  );
  it.each([
    ["0.1.0-dev.0", "next", false],
    ["0.1.0-dev.1", "next", true],
    ["0.1.0-dev.0", "beta", true],
  ])(
    "limits the initial latest exception to its exact version and next channel: %s %s",
    async (version, channel, removesLatest) => {
      const target = { name: "@fixture/package", version, channel };
      const tags = { latest: version };
      const commands = [];
      const adapter = npmAdapter({
        directory: ".",
        retainInitialLatestVersion: "0.1.0-dev.0",
        request: async () => ({ ...tags }),
        runner: {
          run(args, authenticated) {
            expect(authenticated).toBe(true);
            commands.push(args);
            if (args[1] === "rm") delete tags.latest;
            else tags[channel] = version;
          },
        },
      });
      const operation = adapter.promote(target, null);
      expect(await operation.read()).toBeNull();
      await operation.write();
      expect(commands.some((args) => args[1] === "rm")).toBe(removesLatest);
      expect(tags.latest).toBe(removesLatest ? undefined : version);
      expect(tags[channel]).toBe(version);
      expect(await operation.read()).toBe(version);
      expect((await operation.verify(version)).new).toBe(version);
      await operation.write();
      expect(commands).toHaveLength(removesLatest ? 2 : 1);
    },
  );
  it("rejects a stable version as the initial latest exception", () => {
    expect(() => npmAdapter({ retainInitialLatestVersion: "0.1.0" })).toThrow(
      "must name a prerelease",
    );
  });
  it("preserves a different stable version during prerelease promotion", async () => {
    const tags = { latest: "0.0.9" };
    const target = {
      name: "@fixture/package",
      channel: "next",
      version: "0.1.0-dev.0",
    };
    const adapter = npmAdapter({
      directory: ".",
      request: async () => ({ ...tags }),
      runner: {
        run(args) {
          expect(args[1]).toBe("add");
          tags.next = target.version;
        },
      },
    });
    const operation = adapter.promote(target, null);
    await operation.write();
    await operation.verify(await operation.read());
    expect(tags.latest).toBe("0.0.9");
  });
  it("resumes when channel promotion fails after removing the unintended tag", async () => {
    const target = {
      name: "@fixture/package",
      channel: "next",
      version: "0.1.0-dev.0",
    };
    const tags = { latest: target.version };
    let failPromotion = true;
    const adapter = npmAdapter({
      directory: ".",
      wait: async () => {},
      request: async () => ({ ...tags }),
      runner: {
        run(args) {
          if (args[1] === "rm") {
            expect(tags.latest).toBe(target.version);
            delete tags.latest;
          } else if (failPromotion) {
            throw new Error("Interrupted promotion");
          } else {
            tags.next = target.version;
          }
        },
      },
    });
    const operation = adapter.promote(target, null);
    await expect(operation.write()).rejects.toThrow("Interrupted promotion");
    expect(tags).toEqual({});
    expect(await operation.read()).toBeNull();
    failPromotion = false;
    await operation.write();
    await operation.verify(await operation.read());
    expect(tags).toEqual({ next: target.version });
  });
});

describe("Marketplace destination", () => {
  it("rejects a packaged channel mismatch before credentials or remote writes", async () => {
    const w = workspace();
    try {
      let calls = 0;
      const adapter = marketplaceAdapter({
        directory: w.directory,
        publisherId: "fixture-id",
        request: async () => {
          calls += 1;
        },
        credential: async () => {
          calls += 1;
        },
      });
      await expect(
        adapter.preflight({
          targets: [
            {
              kind: "vsix",
              name: "fixture.extension",
              channel: "stable",
              archive: w.archive,
            },
          ],
        }),
      ).rejects.toThrow("VSIX channel differs");
      expect(calls).toBe(0);
    } finally {
      w.close();
    }
  });
  it.each([360000, 900000, 1200000, null])(
    "observes validation at %s milliseconds without resubmitting",
    async (validationDelay) => {
      const w = workspace();
      try {
        let elapsed = 0;
        const writes = [];
        const target = {
          name: "fixture.extension",
          version: "0.1.0",
          channel: "pre-release",
          archive: w.archive,
        };
        const adapter = marketplaceAdapter({
          directory: w.directory,
          publisherId: "fixture-id",
          now: () => elapsed,
          wait: async (ms) => {
            elapsed += ms;
          },
          request: async (_url, options) => {
            if (options?.method) writes.push(options.method);
            return {
              publisher: {
                publisherName: "fixture",
                publisherId: "fixture-id",
              },
              extensionName: "extension",
              extensionId: "extension-id",
              versions: [
                {
                  version: target.version,
                  flags:
                    validationDelay !== null && elapsed >= validationDelay
                      ? "validated"
                      : "none",
                  properties: [
                    {
                      key: "Microsoft.VisualStudio.Code.PreRelease",
                      value: "true",
                    },
                    {
                      key: "Microsoft.VisualStudio.Services.VsixSha256",
                      value: w.archive.sha256,
                    },
                  ],
                },
              ],
            };
          },
        });
        const operation = adapter.upload(target);
        const result = operation.verify(await operation.read());
        if (validationDelay === null)
          await expect(result).rejects.toThrow("still pending");
        else
          await expect(result).resolves.toMatchObject({
            version: target.version,
            registeredSha256: w.archive.sha256,
          });
        expect(elapsed).toBe(validationDelay ?? 1200000);
        expect(writes).toEqual([]);
      } finally {
        w.close();
      }
    },
  );
  it("compares payload files when signing changes container bytes", () => {
    const w = workspace();
    try {
      const changed = zipEntries({
        "extension/package.json": Buffer.from(
          '{"publisher":"fixture","name":"extension","version":"0.1.0"}',
        ),
        "extension/code.js": Buffer.from("export const value = 1;"),
        "extension.vsixmanifest": Buffer.from(
          '<Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/></Properties>',
        ),
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
      let validationWaits = 0;
      let publicBytes = w.bytes;
      const publisherId = "fixture-publisher-id";
      const remote = {
        extensionName: "extension",
        extensionId: "fixture-extension-id",
        flags: "validated, preview",
        publisher: { publisherName: "fixture", publisherId },
        versions: [
          {
            version: "0.1.0",
            flags: "none",
            properties: [],
          },
        ],
      };
      const request = async (url, options) => {
        calls.push({ url, options });
        if (options.method === "POST") {
          uploaded = true;
          return remote;
        }
        if (options.method === "PATCH") {
          expect(url).toContain("flags=2304&api-version=7.2-preview.2");
          expect(options.body).toBeUndefined();
          remote.flags = "validated, public, preview";
          return remote;
        }
        if (options.binary) {
          expect(url).toContain("/_apis/public/");
          return publicBytes;
        }
        if (url.includes("/extensions/")) return uploaded ? remote : null;
        return { publisherId, publisherName: "fixture" };
      };
      const adapter = marketplaceAdapter({
        request,
        credential: async () => "fixture-access",
        directory: w.directory,
        publisherId,
        wait: async () => {
          validationWaits += 1;
          remote.versions[0].flags = "validated";
          remote.versions[0].properties = [
            { key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" },
            {
              key: "Microsoft.VisualStudio.Services.VsixSha256",
              value: w.archive.sha256,
            },
          ];
        },
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
      expect(validationWaits).toBe(1);
      expect(receipt).toMatchObject({
        publisher: "fixture",
        publisherId,
        version: "0.1.0",
        channel: "pre-release",
        targetPlatform: "universal",
        submittedSha256: w.archive.sha256,
        registeredSha256: w.archive.sha256,
      });
      expect(JSON.stringify(receipt)).not.toContain("fixture-access");
      await expect(op.write()).rejects.toThrow("already exists");
      const visibility = adapter.visibility(target);
      expect(await visibility.read()).toBeNull();
      await visibility.write();
      publicBytes = zipEntries({ "unexpected.js": Buffer.from("changed") });
      await expect(visibility.verify(await visibility.read())).rejects.toThrow(
        "Unexpected Marketplace payload entries",
      );
      publicBytes = w.bytes;
      const visible = await visibility.verify(await visibility.read());
      expect(visible.visibility).toBe("public");
      expect(visible.publicDownload.byteIdentical).toBe(true);
      const publicRead = calls.find((call) =>
        call.url.includes("/_apis/public/"),
      );
      expect(publicRead.options.headers).toBeUndefined();
      await visibility.write();
      expect(
        calls.filter((call) => call.options.method === "PATCH"),
      ).toHaveLength(1);
      expect(
        calls.filter((call) => call.options.method === "POST"),
      ).toHaveLength(1);
      target.channel = "stable";
      await expect(op.verify(await op.read())).rejects.toThrow("channel");
    } finally {
      w.close();
    }
  });
  it.each([
    "pending",
    "rejected",
    "validated",
    "tampered",
    "missing-digest",
    "locked",
  ])("waits for validation without publishing %s content", async (state) => {
    const w = workspace();
    try {
      let waits = 0;
      let elapsed = 0;
      const mutations = [];
      const version = {
        version: "0.1.0",
        flags: ["validated", "tampered", "missing-digest", "locked"].includes(
          state,
        )
          ? "validated"
          : "none",
        properties: ["tampered", "missing-digest", "locked"].includes(state)
          ? [
              { key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" },
              {
                key: "Microsoft.VisualStudio.Services.VsixSha256",
                value:
                  state === "missing-digest"
                    ? undefined
                    : state === "tampered"
                      ? "0".repeat(64)
                      : w.archive.sha256,
              },
            ]
          : [],
        ...(state === "rejected"
          ? { validationResultMessage: "Rejected" }
          : {}),
      };
      const remote = {
        publisher: { publisherName: "fixture", publisherId: "fixture-id" },
        extensionName: "extension",
        extensionId: "extension-id",
        flags: state === "locked" ? "validated, preview, locked" : "preview",
        versions: [version],
      };
      const target = {
        name: "fixture.extension",
        version: "0.1.0",
        channel: "pre-release",
        archive: w.archive,
      };
      const adapter = marketplaceAdapter({
        directory: w.directory,
        publisherId: "fixture-id",
        now: () => elapsed,
        wait: async (duration) => {
          waits += 1;
          elapsed += duration;
        },
        request: async (_url, options) => {
          if (options?.method) mutations.push(options.method);
          if (options?.binary)
            return state === "tampered"
              ? zipEntries({ "unexpected.js": Buffer.from("changed") })
              : w.bytes;
          return remote;
        },
      });
      const failures = {
        pending: "still pending",
        rejected: "validation failed",
        validated: "channel collision",
        tampered: "registered archive collision",
        "missing-digest": "registered archive collision",
        locked: "Unexpected Marketplace visibility flags",
      };
      await expect(adapter.visibility(target).write()).rejects.toThrow(
        failures[state],
      );
      expect(waits).toBe(state === "pending" ? 120 : 0);
      expect(mutations).toEqual([]);
    } finally {
      w.close();
    }
  });
});

it.each(["paginated", "ambiguous", "unbounded"])(
  "discovers GitHub drafts with %s listing results",
  async (state) => {
    const plan = {
      repository: "fixture/repo",
      tag: "fixture-tag",
      sourceSha: "a".repeat(40),
      candidate: "b".repeat(64),
      targets: [{ kind: "npm", channel: "next" }],
    };
    const draft = {
      id: 42,
      tag_name: plan.tag,
      target_commitish: plan.sourceSha,
      body: "Fixture changes and compatibility notes.",
      prerelease: true,
      draft: true,
    };
    let pages = 0;
    const adapter = releaseAdapter({
      notes: () => "Fixture changes and compatibility notes.",
      journal: { assertWriteAccess() {} },
      api: async (method, path) => {
        expect(method).toBe("GET");
        if (path.endsWith("/fixture/repo"))
          return { full_name: plan.repository, private: false };
        if (!path.includes("/releases?")) return null;
        pages += 1;
        expect(path.endsWith(`per_page=100&page=${pages}`)).toBe(true);
        if (state === "ambiguous") return [draft, { ...draft, id: 43 }];
        if (state === "paginated" && pages === 2) return [draft];
        return Array.from({ length: 100 }, (_, index) => ({
          tag_name: `other-${pages}-${index}`,
        }));
      },
    });
    if (state === "paginated") {
      await adapter.preflight(plan);
      expect(pages).toBe(2);
    } else {
      await expect(adapter.preflight(plan)).rejects.toThrow(
        state === "ambiguous" ? "Ambiguous" : "pagination bound",
      );
      expect(pages).toBe(state === "ambiguous" ? 1 : 10);
    }
  },
);

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
        };
      if (path.includes("/git/ref/")) return tag;
      if (path.endsWith("/git/refs")) {
        tag = { object: { type: "commit", sha: body.sha } };
        return tag;
      }
      if (path.includes("/releases/tags/"))
        return release?.draft ? null : release;
      if (path.includes("/releases?")) return release ? [release] : [];
      if (method === "GET" && path.endsWith("/releases/1")) return release;
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
    let writeAccess = false;
    const adapter = releaseAdapter({
      notes: () => "Fixture changes and compatibility notes.",
      api,
      request,
      token: "fixture-token",
      directory: w.directory,
      journal: {
        assertWriteAccess(repository) {
          expect(repository).toBe(plan.repository);
          if (!writeAccess)
            throw new Error("Journal write access is unverified");
        },
      },
    });
    await expect(adapter.preflight(plan)).rejects.toThrow("unverified");
    expect(mutations).toEqual([]);
    writeAccess = true;
    await adapter.preflight(plan);
    for await (const op of adapter.operations(plan)) {
      if (!(await op.read())) await op.write();
      await op.verify(await op.read());
    }
    expect(release.draft).toBe(false);
    expect(release.body).toBe("Fixture changes and compatibility notes.");
    const correctBody = release.body;
    release.body = "Changed release description";
    await expect(adapter.preflight(plan)).rejects.toThrow(
      "description collision",
    );
    release.body = correctBody;
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
    path: ".github/workflows/verify.yml",
    event: "push",
    head_sha: "a".repeat(40),
    repository: { full_name: "fixture/repo" },
    head_repository: { full_name: "fixture/repo" },
    head_branch: "main",
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
  expect(workflow.on).toEqual({
    workflow_run: {
      workflows: ["Verify language"],
      types: ["completed"],
      branches: ["main"],
    },
  });
  expect(workflow.permissions).toEqual({});
  expect(workflow.concurrency).toEqual({
    group: "publication",
    "cancel-in-progress": false,
    queue: "max",
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
  expect(publication).toContain("publish-release.mjs all");
  expect(publication.match(/publish-release.mjs/g)).toHaveLength(1);
  expect(text).not.toContain("secrets.");
});

it("uses the matching notes from the verified candidate source, with no later versions", () => {
  const w = workspace();
  try {
    const bytes = zipEntries({
      "CHANGELOG.md": Buffer.from(
        "# Changelog\n\n## 0.2.0-dev.0 / VS Code 0.3.0\n\n" +
          "- New document feature.\n\n### Compatibility\n\n" +
          "- Desktop only.\n\n## 0.1.0-dev.0 / VS Code 0.1.0\n\n- Older notes.\n",
      ),
    });
    writeFileSync(join(w.directory, "source.zip"), bytes);
    const plan = {
      repository: "fixture/repo",
      sourceSha: "a".repeat(40),
      candidate: "b".repeat(64),
      targets: [
        { id: "source", archive: fileRecord("source.zip", bytes) },
        { kind: "npm", version: "0.2.0-dev.0" },
        { id: "vscode", version: "0.3.0" },
      ],
    };
    const notes = candidateReleaseNotes(plan, w.directory);
    expect(notes).toContain("- New document feature.");
    expect(notes).toContain("### Compatibility\n\n- Desktop only.");
    expect(notes).not.toContain("Older notes");
    expect(notes).toContain(`/blob/${plan.sourceSha}/README.md`);
    expect(notes).toContain(`Candidate SHA-256: ${plan.candidate}`);
    plan.targets[1].version = "0.4.0";
    expect(() => candidateReleaseNotes(plan, w.directory)).toThrow(
      "release notes",
    );
    writeFileSync(
      join(w.directory, "source.zip"),
      Buffer.from("changed bytes"),
    );
    expect(() => candidateReleaseNotes(plan, w.directory)).toThrow();
  } finally {
    w.close();
  }
});
