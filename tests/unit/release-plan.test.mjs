import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  coordinatedVersions,
  generateReleasePlan,
  readReleaseVersions,
} from "../../scripts/release-plan.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function repository(messages) {
  const directory = mkdtempSync(join(tmpdir(), "tinta release plan "));
  directories.push(directory);
  const origin = join(directory, "origin.git");
  const cwd = join(directory, "checkout");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  mkdirSync(cwd);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgSign", "false");
  git("config", "tag.gpgSign", "false");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "private-product",
      version: "0.0.0",
      private: true,
    }),
  );
  git("add", "package.json");
  git("commit", "-m", "chore: baseline");
  git("tag", "tinta-v0.1.21-vscode-0.2.21-stable");
  git("remote", "add", "origin", origin);
  for (const message of messages) git("commit", "--allow-empty", "-m", message);
  git("push", "-u", "origin", "main", "--tags");
  return { cwd, git };
}

it.each([
  ["patch", "0.1.22", "0.2.22"],
  ["minor", "0.2.0", "0.4.0"],
  ["major", "1.0.0", "0.4.0"],
])(
  "maps a %s recommendation to coordinated versions",
  (_kind, recommendation, extension) => {
    const versions = coordinatedVersions(
      { implementation: "0.1.21", extension: "0.2.21" },
      recommendation,
    );
    expect(versions).toEqual({
      implementation: recommendation === "1.0.0" ? "0.2.0" : recommendation,
      extension,
      npmChannel: "latest",
      extensionChannel: "stable",
    });
  },
);

it.each([
  ["fix(parser): repair input", "0.1.22", "0.2.22"],
  ["perf(engine): speed up evaluation", "0.1.22", "0.2.22"],
  ["revert: restore previous behavior", "0.1.22", "0.2.22"],
  [
    "fix(api): change input\n\nBREAKING CHANGE: incompatible input",
    "0.2.0",
    "0.4.0",
  ],
  ["feat(cli): support a command", "0.2.0", "0.4.0"],
  ["feat(cli)!: incompatible command", "0.2.0", "0.4.0"],
  ["docs: clarify usage", "0.1.21", "0.2.21"],
])(
  "uses the real release tool for %s without source, commit or tag writes",
  (message, implementation, extension) => {
    const f = repository([message]);
    const source = readFileSync(join(f.cwd, "package.json"));
    const refs = f.git("show-ref", "--heads", "--tags");
    const plan = generateReleasePlan(f.cwd);
    expect(plan.sourceSha).toBe(f.git("rev-parse", "HEAD"));
    expect(plan.implementation).toBe(implementation);
    expect(plan.extension).toBe(extension);
    expect(plan.publish).toBe(!message.startsWith("docs:"));
    expect(plan.tag).toBe(
      `tinta-v${implementation}-vscode-${extension}-stable`,
    );
    expect(readFileSync(join(f.cwd, "package.json"))).toEqual(source);
    expect(f.git("show-ref", "--heads", "--tags")).toBe(refs);
    if (message.startsWith("fix(parser):")) {
      const module = new URL(
        "../../scripts/release-contract.mjs",
        import.meta.url,
      );
      const resolved = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { loadReleaseConfig } from ${JSON.stringify(module.href)};
console.log(JSON.stringify(loadReleaseConfig().versions));`,
        ],
        {
          cwd: f.cwd,
          env: { ...process.env, TINTA_RELEASE_SOURCE_SHA: plan.sourceSha },
          encoding: "utf8",
        },
      );
      expect(JSON.parse(resolved)).toMatchObject({
        implementation,
        extension,
        npmChannel: "latest",
        extensionChannel: "stable",
      });
    }
    const path = join(f.cwd, "reports/release/plan.json");
    expect(readReleaseVersions(plan.sourceSha, path).implementation).toBe(
      implementation,
    );
    expect(() => readReleaseVersions("a".repeat(40), path)).toThrow(
      "checkout mismatch",
    );
    if (plan.publish) {
      expect(plan.notes).toContain(implementation);
      expect(plan.notes).not.toContain("1.0.0");
      expect(
        readFileSync(join(f.cwd, "reports/release/notes.md"), "utf8"),
      ).toBe(plan.notes + "\n");
    }
  },
  15000,
);

it("rejects invalid, non-increasing and odd-minor version inputs", () => {
  for (const version of ["invalid", "0.1.20", "0.1.21"])
    expect(() =>
      coordinatedVersions(
        { implementation: "0.1.21", extension: "0.2.21" },
        version,
      ),
    ).toThrow();
  expect(() =>
    coordinatedVersions(
      { implementation: "0.1.21", extension: "0.1.21" },
      "0.2.0",
    ),
  ).toThrow();
});

it.each([
  ["1.7.9", "1.4.9", "2.0.0", "2.0.0", "2.0.0"],
  ["1.7.9", "0.4.9", "2.0.0", "2.0.0", "0.6.0"],
  ["0.7.9", "1.4.9", "1.0.0", "0.8.0", "2.0.0"],
])(
  "preserves independent breaking-version policy from npm %s and extension %s",
  (implementation, extension, recommendation, nextNpm, nextExtension) => {
    expect(
      coordinatedVersions({ implementation, extension }, recommendation),
    ).toEqual({
      implementation: nextNpm,
      extension: nextExtension,
      npmChannel: "latest",
      extensionChannel: "stable",
    });
  },
);
