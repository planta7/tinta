import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { execFileSync } from "node:child_process";
import {
  nextComponentVersion,
  affectedComponents,
  generateReleasePlan,
  readReleaseVersions,
} from "../../scripts/release-plan.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

it.each([
  ["packages/engine/src/index.ts", ["language", "studio", "vscode"]],
  ["apps/studio/src/editor.ts", ["studio"]],
  ["apps/vscode/src/extension.ts", ["vscode"]],
  ["apps/studio/src/preview.ts", ["studio", "vscode"]],
])(
  "verifies pending %s changes after a documentation-only push",
  (path, expected) => {
    const f = repository();
    f.change(path, "fix: repair pending component");
    const before = f.git("rev-parse", "HEAD");
    f.change("README.md", "docs: clarify usage");
    const source = f.git("rev-parse", "HEAD");
    const command = [
      fileURLToPath(new URL("../../scripts/release-plan.mjs", import.meta.url)),
      "--affected",
      before,
      source,
    ];
    const run = (...flags) =>
      JSON.parse(
        execFileSync(process.execPath, [...command, ...flags], {
          cwd: f.cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: "",
            TINTA_RELEASE_SOURCE_SHA: "",
          },
        }),
      );
    expect(run()).toEqual([]);
    expect(run("--pending")).toEqual(expected);
  },
  15000,
);

function repository(messages = []) {
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
  writeFileSync(join(cwd, ".gitattributes"), readFileSync(".gitattributes"));
  git("add", "package.json", ".gitattributes");
  git("commit", "-m", "chore: baseline");
  git("tag", "tinta-v0.1.21-vscode-0.2.21-stable");
  git("remote", "add", "origin", origin);
  const change = (path, message) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), message + "\n");
    git("add", "--", path);
    git("commit", "-m", message);
    git("push", "origin", "main", "--tags");
  };
  git("push", "-u", "origin", "main", "--tags");
  for (const message of messages) change("packages/engine/change.txt", message);
  git("push", "-u", "origin", "main", "--tags");
  return { cwd, git, change };
}

it.each([
  ["patch", "0.1.22", "0.2.22"],
  ["minor", "0.2.0", "0.4.0"],
  ["major", "1.0.0", "0.4.0"],
])(
  "maps a %s recommendation to each component version",
  (_kind, recommendation, extension) => {
    expect(nextComponentVersion("language", "0.1.21", recommendation)).toBe(
      recommendation === "1.0.0" ? "0.2.0" : recommendation,
    );
    expect(
      nextComponentVersion("vscode", "0.2.21", semver.inc("0.2.21", _kind)),
    ).toBe(extension);
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
    expect(plan.components.language.tag).toBe(
      `tinta-language-v${implementation}`,
    );
    expect(plan.components.vscode.tag).toBe(`tinta-vscode-v${extension}`);
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
      expect(plan.components.language.notes).toContain(implementation);
      expect(plan.components.language.notes).not.toContain("1.0.0");
      expect(
        readFileSync(join(f.cwd, "reports/release/notes-language.md"), "utf8"),
      ).toBe(plan.components.language.notes + "\n");
    }
  },
  15000,
);

it("rejects invalid, non-increasing and odd-minor version inputs", () => {
  for (const version of ["invalid", "0.1.20", "0.1.21"])
    expect(() => nextComponentVersion("language", "0.1.21", version)).toThrow();
  expect(() => nextComponentVersion("vscode", "0.1.21", "0.2.0")).toThrow();
});

it.each([
  ["1.7.9", "1.4.9", "2.0.0", "2.0.0", "2.0.0"],
  ["1.7.9", "0.4.9", "2.0.0", "2.0.0", "0.6.0"],
  ["0.7.9", "1.4.9", "1.0.0", "0.8.0", "2.0.0"],
])(
  "preserves independent breaking-version policy from npm %s and extension %s",
  (implementation, extension, recommendation, nextNpm, nextExtension) => {
    expect(
      nextComponentVersion("language", implementation, recommendation),
    ).toBe(nextNpm);
    expect(
      nextComponentVersion("vscode", extension, semver.inc(extension, "major")),
    ).toBe(nextExtension);
  },
);

it.each([
  ["apps/studio/src/navigation.ts", ["studio"]],
  ["packages/cli/src/index.ts", ["studio"]],
  ["apps/vscode/src/extension.ts", ["vscode"]],
  ["apps/studio/src/preview.ts", ["studio", "vscode"]],
  ["apps/studio/src/protocol.ts", ["studio", "vscode"]],
  ["apps/studio/src/preview.css", ["studio", "vscode"]],
  ["packages/engine/src/index.ts", ["language", "studio", "vscode"]],
  ["new-input/config.json", ["language", "studio", "vscode"]],
])("selects only actual delivery consumers of %s", (path, expected) => {
  const f = repository();
  const before = f.git("rev-parse", "HEAD");
  f.change(path, "fix(component): repair behavior");
  expect(affectedComponents(before, f.git("rev-parse", "HEAD"), f.cwd)).toEqual(
    expected,
  );
});

it("a Studio-only release leaves library and extension versions unchanged", () => {
  const f = repository();
  f.change("apps/studio/src/navigation.ts", "fix(studio): restore navigation");
  const plan = generateReleasePlan(f.cwd);
  expect(plan.matrix.component).toEqual(["studio"]);
  expect(plan.implementation).toBe("0.1.21");
  expect(plan.studio).toBe("0.1.22");
  expect(plan.extension).toBe("0.2.21");
  expect(plan.components.language.publish).toBe(false);
  expect(plan.components.vscode.publish).toBe(false);
  expect(plan.components.studio.notes).toContain("restore navigation");
});

it("keeps an independent cumulative history across another component's tag", () => {
  const f = repository();
  f.change("apps/studio/src/navigation.ts", "feat(studio): add navigation");
  f.change("apps/vscode/src/extension.ts", "fix(vscode): repair command");
  f.git("tag", "tinta-vscode-v0.2.22");
  f.git("push", "origin", "--tags");
  f.change("apps/studio/src/editor.ts", "docs(studio): clarify editor source");
  const plan = generateReleasePlan(f.cwd);
  expect(plan.matrix.component).toEqual(["studio"]);
  expect(plan.studio).toBe("0.2.0");
  expect(plan.extension).toBe("0.2.22");
  expect(plan.components.studio.notes).toContain("add navigation");
  expect(plan.components.studio.notes).not.toContain("repair command");
});

it("catches up unreleased language dependencies before publishing a host", () => {
  const f = repository();
  f.change(
    "packages/engine/src/index.ts",
    "refactor(engine): simplify evaluation",
  );
  expect(generateReleasePlan(f.cwd).publish).toBe(false);
  f.change("apps/studio/src/editor.ts", "fix(studio): restore editor");
  const plan = generateReleasePlan(f.cwd);
  expect(plan.matrix.component).toEqual(["language", "studio", "vscode"]);
  expect(plan.implementation).toBe("0.1.22");
  expect(plan.studio).toBe("0.1.22");
  expect(plan.extension).toBe("0.2.22");
}, 15000);

it("treats a cross-component rename as affecting both old and new owners", () => {
  const f = repository();
  f.change("apps/studio/fixture.ts", "chore(studio): add fixture");
  const before = f.git("rev-parse", "HEAD");
  mkdirSync(join(f.cwd, "apps/vscode"), { recursive: true });
  f.git("mv", "apps/studio/fixture.ts", "apps/vscode/fixture.ts");
  f.git("commit", "-m", "fix(host): move fixture");
  expect(affectedComponents(before, f.git("rev-parse", "HEAD"), f.cwd)).toEqual(
    ["studio", "vscode"],
  );
  expect(
    affectedComponents("0".repeat(40), f.git("rev-parse", "HEAD"), f.cwd),
  ).toEqual(["language", "studio", "vscode"]);
});

it("includes an unreleased feature merged from a branch and ignores unrelated branch paths", () => {
  const f = repository();
  f.git("checkout", "-b", "feature/studio-navigation");
  f.change(
    "apps/studio/src/navigation.ts",
    "feat(studio): add branch navigation",
  );
  f.git("checkout", "main");
  f.change("apps/vscode/src/extension.ts", "docs(vscode): clarify host");
  f.git(
    "merge",
    "--no-ff",
    "feature/studio-navigation",
    "-m",
    "Merge studio navigation",
  );
  const plan = generateReleasePlan(f.cwd);
  expect(plan.matrix.component).toEqual(["studio"]);
  expect(plan.studio).toBe("0.2.0");
  expect(plan.components.studio.notes).toContain("add branch navigation");
});

it("never reuses an allocated component version after a failed upload", () => {
  const f = repository();
  f.change("apps/studio/src/editor.ts", "fix(studio): first repair");
  f.git("tag", "tinta-studio-v0.1.22");
  f.git("push", "origin", "--tags");
  f.change("apps/studio/src/editor.ts", "fix(studio): follow-up repair");
  const plan = generateReleasePlan(f.cwd);
  expect(plan.matrix.component).toEqual(["studio"]);
  expect(plan.studio).toBe("0.1.23");
  expect(plan.components.studio.notes).not.toContain("first repair");
  expect(plan.components.studio.notes).toContain("follow-up repair");
});

it.each([
  ["README.md", []],
  ["docs/15_DISTRIBUTION.md", []],
  ["scripts/README.md", []],
  ["packages/engine/README.md", ["language", "studio", "vscode"]],
  ["spec/02_EXPRESSIONS_AND_STATE.md", ["language", "studio", "vscode"]],
])(
  "classifies %s without treating prose as implementation changes",
  (path, expected) => {
    const f = repository();
    const before = f.git("rev-parse", "HEAD");
    f.change(path, "docs: clarify documentation");
    expect(
      affectedComponents(before, f.git("rev-parse", "HEAD"), f.cwd),
    ).toEqual(expected);
  },
);
