import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import semver from "semver";
import { setTimeout } from "node:timers/promises";
import { readTarball, digest } from "./distribution-archive.mjs";
import { checkFile } from "./release-candidate.mjs";

export const publishingNpmVersion = "11.21.0";

export function npmRunner(cli, env = process.env, execute = spawnSync) {
  const cwd = mkdtempSync(join(tmpdir(), "tinta-publisher-"));
  writeFileSync(join(cwd, "npmrc"), "");
  writeFileSync(join(cwd, "global-npmrc"), "");
  const base = {
    PATH: env.PATH,
    HOME: cwd,
    npm_config_userconfig: join(cwd, "npmrc"),
    npm_config_globalconfig: join(cwd, "global-npmrc"),
    npm_config_cache: join(cwd, "cache"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "30000",
  };
  const run = (args, authenticated = false, directory = cwd) => {
    const oidc = authenticated
      ? Object.fromEntries(
          [
            "GITHUB_ACTIONS",
            "GITHUB_SERVER_URL",
            "GITHUB_EVENT_NAME",
            "GITHUB_REPOSITORY_ID",
            "GITHUB_REPOSITORY_OWNER_ID",
            "GITHUB_REPOSITORY",
            "GITHUB_REF",
            "GITHUB_SHA",
            "GITHUB_WORKFLOW_REF",
            "GITHUB_WORKFLOW_SHA",
            "GITHUB_RUN_ID",
            "GITHUB_RUN_ATTEMPT",
            "RUNNER_ENVIRONMENT",
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
          ]
            .map((name) => [name, env[name]])
            .filter(([, value]) => value !== undefined),
        )
      : {};
    if (authenticated) {
      assert.equal(env.GITHUB_ACTIONS, "true");
      assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
      assert.ok(
        oidc.ACTIONS_ID_TOKEN_REQUEST_URL &&
          oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      );
    }
    const result = execute(process.execPath, [resolve(cli), ...args], {
      cwd: directory,
      env: { ...base, ...oidc },
      shell: false,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    assert.ok(
      !result.error && result.status === 0,
      "Pinned npm operation failed; reconcile before retry",
    );
    return result.stdout.trim();
  };
  assert.equal(run(["--version"]), publishingNpmVersion);
  return { run, cwd };
}

export function npmAdapter({
  request,
  runner,
  directory,
  registry = "https://registry.npmjs.org",
  retainInitialLatestVersion = null,
  wait = setTimeout,
}) {
  assert.ok(
    retainInitialLatestVersion === null ||
      (semver.valid(retainInitialLatestVersion) &&
        semver.prerelease(retainInitialLatestVersion) !== null),
    "Initial latest exception must name a prerelease version",
  );
  const url = new URL(registry);
  assert.ok(
    url.href === "https://registry.npmjs.org/" ||
      (url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash),
    "Registry must be fixed production origin or isolated loopback",
  );
  const base = url.origin;
  const metadata = (target) =>
    request(`${base}/${encodeURIComponent(target.name)}`, { missing: true });
  const channelTags = async (target) =>
    (await request(
      `${base}/-/package/${encodeURIComponent(target.name)}/dist-tags`,
      { headers: { "Cache-Control": "no-cache" } },
    )) ?? {};
  const version = async (target) =>
    (await metadata(target))?.versions?.[target.version] ?? null;
  const verify = async (target, remote) => {
    assert.equal(remote.name, target.name);
    assert.equal(remote.version, target.version);
    assert.equal(
      remote.dist.integrity,
      target.archive.integrity,
      "Immutable npm version collision",
    );
    assert.deepEqual(remote.dependencies ?? {}, {
      ...target.externalDependencies,
      ...Object.fromEntries(
        target.dependencies.map((d) => [d.name, d.version]),
      ),
    });
    const tarball = new URL(remote.dist.tarball);
    assert.equal(tarball.origin, base, "Unexpected registry tarball origin");
    const bytes = await request(tarball.href, { binary: true });
    assert.equal(
      digest(bytes),
      target.archive.sha256,
      "Registry archive mismatch",
    );
    return {
      name: target.name,
      version: target.version,
      integrity: remote.dist.integrity,
      sha256: digest(bytes),
    };
  };
  return {
    async preflight(plan) {
      for (const target of plan.targets.filter((t) => t.kind === "npm")) {
        assert.ok(
          await metadata(target),
          "Package bootstrap is required separately",
        );
        checkFile(directory, target.archive);
      }
    },
    upload(target, plan) {
      return {
        retryAbsent: true,
        read: () => version(target),
        write: async () => {
          checkFile(directory, target.archive);
          runner.run(
            [
              "publish",
              resolve(directory, target.archive.path),
              "--registry",
              base,
              "--access",
              "public",
              "--tag",
              `candidate-${plan.candidate}`,
              "--ignore-scripts",
            ],
            true,
          );
        },
        verify: (remote) => verify(target, remote),
      };
    },
    async verifyInstall(targets) {
      const cwd = mkdtempSync(join(tmpdir(), "tinta-published-install-"));
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: Object.fromEntries(
            targets.map((t) => [t.name, t.version]),
          ),
        }),
      );
      runner.run(
        [
          "install",
          "--registry",
          base,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        false,
        cwd,
      );
      for (const target of targets) {
        await verify(target, await version(target));
        const entries = readTarball(checkFile(directory, target.archive));
        for (const [path, bytes] of Object.entries(entries)) {
          assert.equal(
            digest(readFileSync(join(cwd, "node_modules", target.name, path))),
            digest(bytes),
            "Installed package bytes differ",
          );
        }
      }
    },
    async channel(target) {
      return (await channelTags(target))[target.channel] ?? null;
    },
    promote(target, previous) {
      const prerelease =
        target.channel !== "latest" &&
        semver.prerelease(target.version) !== null;
      const removePrereleaseLatest =
        prerelease &&
        !(
          target.channel === "next" &&
          target.version === retainInitialLatestVersion
        );
      const tags = () => channelTags(target);
      let submissionStarted = false;
      return {
        retryAbsent: true,
        read: async () => {
          const attempts = submissionStarted ? 13 : 1;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const observed = await tags();
            const current = observed[target.channel] ?? null;
            if (current === target.version) {
              if (
                !removePrereleaseLatest ||
                observed.latest !== target.version
              ) {
                return current;
              }
            } else {
              assert.equal(current, previous, "Channel changed concurrently");
            }
            if (attempt + 1 < attempts) await wait(5000);
          }
          return null;
        },
        write: async () => {
          const observed = await tags();
          const current = observed[target.channel] ?? null;
          assert.ok(
            current === previous || current === target.version,
            "Channel changed concurrently",
          );
          submissionStarted = true;
          if (removePrereleaseLatest && observed.latest === target.version) {
            runner.run(
              ["dist-tag", "rm", target.name, "latest", "--registry", base],
              true,
            );
          }
          if (current === target.version) return;
          runner.run(
            [
              "dist-tag",
              "add",
              `${target.name}@${target.version}`,
              target.channel,
              "--registry",
              base,
            ],
            true,
          );
        },
        verify: async (current) => {
          assert.equal(current, target.version);
          if (removePrereleaseLatest) {
            assert.notEqual(
              (await tags()).latest,
              target.version,
              "Prerelease remains on the stable channel",
            );
          }
          return {
            name: target.name,
            channel: target.channel,
            old: previous,
            new: current,
          };
        },
      };
    },
  };
}
