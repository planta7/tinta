import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRelease,
  prepareCheckout,
  readRequest,
} from "../../scripts/prepare-release.mjs";
import { sha256 } from "../../scripts/release-contract.mjs";
import { stagingManifest } from "../../scripts/distribution-npm.mjs";
import { requireCommandSync } from "../../scripts/commands.mjs";

const config = JSON.parse(readFileSync("toolchain/release.json", "utf8"));
Object.assign(config.versions, {
  implementation: "0.1.0-dev.0",
  npmChannel: "next",
  extension: "0.1.0",
  extensionChannel: "pre-release",
});
const bytes = JSON.stringify(config, null, 2) + "\n";
const changelog = "# Changelog\n\nEarlier changes.\n";
const published = { implementation: [], extension: [] };
const request = () => ({
  baselineSha256: sha256(bytes),
  decision: "synthetic-decision-42",
  versions: {
    implementation: "0.2.0-dev.1",
    npmChannel: "next",
    extension: "0.3.0",
    extensionChannel: "pre-release",
  },
  changes: ["Improve local document recovery."],
  compatibility: ["Source format and protocol identifiers are unchanged."],
});
const prepare = (input = request(), history = published) =>
  prepareRelease(bytes, changelog, history, input);

describe("deterministic release preparation", () => {
  it("produces a minimal, repeatable diff and exact internal edges", () => {
    const plan = prepare();
    expect(plan).toEqual(prepare());
    expect(Object.keys(plan.files)).toEqual([
      "toolchain/release.json",
      "CHANGELOG.md",
    ]);
    const next = JSON.parse(plan.files["toolchain/release.json"]);
    expect({ ...next, versions: config.versions }).toEqual(config);
    for (const field of ["sourceFormat", "contract", "ir", "host", "webview"]) {
      expect(next.versions[field]).toBe(config.versions[field]);
    }
    expect(plan.files["CHANGELOG.md"]).toContain("Earlier changes.");
    expect(plan.files["CHANGELOG.md"]).not.toContain("synthetic-decision");
    for (const target of next.packages) {
      const source = JSON.parse(
        readFileSync(`${target.source}/package.json`, "utf8"),
      );
      const manifest = stagingManifest(next, target, source, []);
      expect(manifest.version).toBe(request().versions.implementation);
      expect(source.private).toBe(true);
      expect(source.version).toBe("0.0.0");
      const expected = plan.dependencies.find(
        (item) => item.name === target.proposedName,
      );
      for (const [name, version] of Object.entries(expected.dependencies)) {
        expect(manifest.dependencies[name]).toBe(version);
      }
    }
    expect(plan.dependencies).toHaveLength(10);
  });

  it("can prepare the configured first version when it has never been published", () => {
    const input = request();
    for (const key of Object.keys(input.versions))
      input.versions[key] = config.versions[key];
    expect(Object.keys(prepare(input).files)).toEqual(["CHANGELOG.md"]);
    expect(() =>
      prepare(input, {
        implementation: [config.versions.implementation],
        extension: [],
      }),
    ).toThrow(/published/);
  });

  it("accepts coordinated stable versions without applying them", () => {
    const input = request();
    input.versions = {
      implementation: "0.2.0",
      npmChannel: "latest",
      extension: "0.4.0",
      extensionChannel: "stable",
    };
    expect(
      JSON.parse(prepare(input).files["toolchain/release.json"]).versions,
    ).toMatchObject(input.versions);
  });

  it.each([
    ["implementation", "1"],
    ["implementation", "v1.2.3"],
    ["implementation", "1.2.3+build"],
    ["implementation", "01.2.3"],
    ["implementation", "0.0.1"],
    ["implementation", "0.2.0-rc.1"],
    ["implementation", "$(touch /tmp/injected)"],
    ["extension", "0.3.0-dev.1"],
    ["extension", "0.3.0+build"],
    ["extension", "0.0.9"],
    ["extension", "0.4.0"],
    ["extension", "0.03.0"],
    ["npmChannel", "latest"],
    ["npmChannel", "beta"],
    ["extensionChannel", "stable"],
    ["extensionChannel", "next"],
  ])("rejects invalid %s = %s", (field, value) => {
    const input = request();
    input.versions[field] = value;
    expect(() => prepare(input)).toThrow();
  });

  it.each(["implementation", "extension"])(
    "rejects reused or overtaken %s",
    (key) => {
      const history = structuredClone(published);
      history[key] = [request().versions[key]];
      expect(() => prepare(request(), history)).toThrow(/published/);
      history[key] = ["9.9.9"];
      expect(() => prepare(request(), history)).toThrow(/published/);
    },
  );

  it("rejects inventory drift, unknown fields, missing decision and malformed notes", () => {
    for (const mutate of [
      (r) => {
        r.baselineSha256 = "0".repeat(64);
      },
      (r) => {
        r.versions.sourceFormat = "2.0";
      },
      (r) => {
        r.decision = "";
      },
      (r) => {
        r.changes = [];
      },
      (r) => {
        r.compatibility = ["line\nbreak"];
      },
      (r) => {
        r.extra = true;
      },
    ]) {
      const input = request();
      mutate(input);
      expect(() => prepare(input)).toThrow();
    }
    const changed = structuredClone(config);
    changed.packages[0].embeddedTargets.push("reader");
    expect(() =>
      prepareRelease(JSON.stringify(changed), changelog, published, request()),
    ).toThrow();
    expect(() =>
      prepareRelease(bytes, "# Incorrect\n", published, request()),
    ).toThrow();
    expect(() => readRequest('{"decision":1,"decision":2}')).toThrow(
      /Duplicate/,
    );
    expect(() => readRequest(" ".repeat(32769))).toThrow(/large/);
  });

  it("reapplies against an immutable Git baseline without touching lock or source identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "tinta-prepare-"));
    const git = (...args) =>
      requireCommandSync(["git", ...args], {
        cwd: directory,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
    try {
      mkdirSync(join(directory, "toolchain"));
      for (const [path, content] of Object.entries({
        "toolchain/release.json": bytes,
        "toolchain/published-versions.json": JSON.stringify(published),
        "CHANGELOG.md": changelog,
        "pnpm-lock.yaml": "unchanged lock\n",
        "source.tinta": '@meta (version: "1.0")\n',
      }))
        writeFileSync(join(directory, path), content);
      git("init", "--quiet");
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Fixture baseline",
      );
      const first = prepareCheckout(request(), directory);
      expect(prepareCheckout(request(), directory)).toEqual(first);
      expect(
        git("diff", "--name-only").stdout.trim().split("\n").sort(),
      ).toEqual(["CHANGELOG.md", "toolchain/release.json"]);
      writeFileSync(join(directory, "CHANGELOG.md"), "Unrelated edits\n");
      expect(() => prepareCheckout(request(), directory)).toThrow(/Unrelated/);
      expect(readFileSync(join(directory, "CHANGELOG.md"), "utf8")).toBe(
        "Unrelated edits\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
