import { beforeAll, describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  inspectPackage,
  packageExtension,
  extensionVersion,
} from "../../scripts/vscode-package.mjs";

const require = createRequire(
  new URL("../../packages/artifacts/package.json", import.meta.url),
);
const { unzipSync, zipSync } = require("fflate");
const path = `build/vscode/tinta-${extensionVersion}.vsix`;

describe("local extension archive", () => {
  beforeAll(async () => {
    await packageExtension();
  });

  it("provides independently valid quickstart examples", async () => {
    const guide = await readFile("docs/14_VSCODE_QUICKSTART.md", "utf8");
    const snippets = [...guide.matchAll(/```tinta\n([\s\S]*?)```/g)];
    expect(snippets).toHaveLength(2);
    for (const [, text] of snippets) {
      const compiled = compile({ text, profile: "tinta", uri: "tinta:guide" });
      expect(compiled.ok).toBe(true);
      const session = createSession(compiled.value);
      expect(session.ok).toBe(true);
      session.value.destroy();
    }
  });
  it("ships only the explicit runtime, language data, identity and notices", async () => {
    const report = inspectPackage(await readFile(path));
    expect(report.files).toHaveLength(13);
    expect(report.identity.contractRevision).toBe("1.0-draft.3");
    expect(report.identity.implementationVersion).toBe("0.0.0");
    expect(report.identity.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      report.files.some((file) => file.path.includes("node_modules")),
    ).toBe(false);
  });

  it.each([
    "extension/.env",
    "extension/tests/fixture.mjs",
    "extension/dist/extension.mjs.map",
    "extension/.local/plan.md",
  ])("rejects an unexpected archive entry %s", async (name) => {
    const entries = unzipSync(await readFile(path));
    entries[name] = new TextEncoder().encode("unexpected");
    expect(() => inspectPackage(zipSync(entries))).toThrow(
      /unexpected entries/,
    );
  });

  it.each([
    "/Users/example/private",
    "C:\\Users\\example\\private",
    "/root/private",
    ".local/automation/plan.md",
    "//# sourceMappingURL=file.map",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ])("rejects forbidden packaged content %s", async (content) => {
    const entries = unzipSync(await readFile(path));
    entries["extension/README.md"] = new TextEncoder().encode(content);
    expect(() => inspectPackage(zipSync(entries))).toThrow(
      /Private or development/,
    );
  });

  it("rejects a runtime whose bytes differ from its identity", async () => {
    const entries = unzipSync(await readFile(path));
    entries["extension/dist/worker.mjs"][0] ^= 1;
    expect(() => inspectPackage(zipSync(entries))).toThrow(/identity mismatch/);
  });

  it("requires every packaged payload to have a matching identity", async () => {
    const entries = unzipSync(await readFile(path));
    const identity = JSON.parse(
      Buffer.from(entries["extension/build-identity.json"]).toString(),
    );
    identity.payload.pop();
    entries["extension/build-identity.json"] = new TextEncoder().encode(
      JSON.stringify(identity),
    );
    expect(() => inspectPackage(zipSync(entries))).toThrow(/build identity/);
  });
});
