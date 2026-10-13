import { implementationVersion } from "../../scripts/implementation-version.mjs";
import { beforeAll, describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let releaseManifest;

  beforeAll(async () => {
    await packageExtension();
  });

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "tinta-release-flags-"));
    try {
      const report = await packageExtension({
        release: true,
        destination: directory,
      });
      const entries = unzipSync(
        await readFile(
          join(directory, `tinta-${report.identity.extensionVersion}.vsix`),
        ),
      );
      releaseManifest = Buffer.from(
        entries["extension.vsixmanifest"],
      ).toString();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks release archives public while retaining their prerelease channel", async () => {
    expect(releaseManifest).toContain(
      "<GalleryFlags>Public Preview</GalleryFlags>",
    );
    expect(releaseManifest).toContain(
      '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/>',
    );
    const local = unzipSync(await readFile(path));
    expect(Buffer.from(local["extension.vsixmanifest"]).toString()).toContain(
      "<GalleryFlags>Preview</GalleryFlags>",
    );
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
    expect(report.files).toHaveLength(14);
    expect(report.identity.contractRevision).toBe("1.0-draft.3");
    expect(report.identity.implementationVersion).toBe(implementationVersion);
    expect(report.identity.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      report.files.some((file) => file.path.includes("node_modules")),
    ).toBe(false);
  });

  it("includes the extension name, description and Studio logo", async () => {
    const entries = unzipSync(await readFile(path));
    const manifest = JSON.parse(
      Buffer.from(entries["extension/package.json"]).toString(),
    );
    const icon = Buffer.from(entries["extension/icon.png"]);

    expect(manifest.displayName).toBe("tinta");
    expect(manifest.description).toContain("interactive Markdown documents");
    expect(manifest.icon).toBe("icon.png");
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(Buffer.from(entries["extension.vsixmanifest"]).toString()).toContain(
      'Path="extension/icon.png"',
    );
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
