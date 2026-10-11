import { describe, it, expect } from "vitest";
import {
  loopbackRegistry,
  verifyIntegrity,
  startRegistry,
  registryPackages,
  dependencyArchive,
} from "../../scripts/consumer-registry.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("sealed consumer registry", () => {
  it.each(["\n", "\r\n"])(
    "extracts the same verified upstream manifest with native tar line endings",
    async (newline) => {
      const root = mkdtempSync(join(tmpdir(), "tinta-tar-listing-"));
      const bytes = Buffer.from("checksum-pinned fixture archive");
      const record = {
        name: "@codemirror/autocomplete",
        version: "6.18.6",
        integrity:
          "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      };
      writeFileSync(join(root, dependencyArchive(record)), bytes);
      const calls = [];
      const extract = (command, args, options) => {
        calls.push(args);
        expect(command).toBe("tar");
        expect(options.input).toEqual(bytes);
        return {
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            args[0] === "-tzf"
              ? ["package/dist/index.js", "package/package.json", ""].join(
                  newline,
                )
              : JSON.stringify({ name: record.name, version: record.version }),
          ),
        };
      };
      try {
        const packages = await registryPackages(
          { targets: [], externalDependencies: [record] },
          root,
          root,
          [],
          { extract },
        );
        expect(packages[0].bytes).toEqual(bytes);
        expect(packages[0].manifest.name).toBe(record.name);
        expect(calls[1]).toEqual(["-xzOf", "-", "package/package.json"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "https://registry.npmjs.org",
    "http://localhost:1234",
    "http://127.0.0.1.example:1234",
    "http://127.0.0.1:1234/path",
    "http://user:secret@127.0.0.1:1234",
    "http://127.0.0.1:1234/?token=secret",
    "http://0.0.0.0:1234",
    "https://127.0.0.1:1234",
  ])("rejects nonisolated destination %s", (url) => {
    expect(() => loopbackRegistry(url)).toThrow();
  });
  it("accepts only a literal loopback origin", () => {
    expect(loopbackRegistry("http://127.0.0.1:1234/")).toBe(
      "http://127.0.0.1:1234",
    );
  });
  it("rejects changed archives before installation", () => {
    const bytes = Buffer.from("reviewed bytes");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
    expect(() => verifyIntegrity(Buffer.from("changed"), integrity)).toThrow();
  });
  it("serves exact immutable bytes and refuses uploads, credentials and unknown packages", async () => {
    const bytes = Buffer.from("immutable fixture bytes");
    const registry = await startRegistry([
      {
        bytes,
        manifest: {
          name: "@tinta/fixture",
          version: "1.0.0",
          dependencies: { exact: "2.0.0" },
        },
      },
    ]);
    try {
      const metadata = await (
        await fetch(`${registry.origin}/@tinta%2ffixture`)
      ).json();
      const version = metadata.versions["1.0.0"];
      expect(version.dependencies).toEqual({ exact: "2.0.0" });
      const downloaded = Buffer.from(
        await (await fetch(version.dist.tarball)).arrayBuffer(),
      );
      expect(downloaded).toEqual(bytes);
      expect((await fetch(`${registry.origin}/unknown`)).status).toBe(404);
      expect((await fetch(`${registry.origin}/%invalid`)).status).toBe(400);
      expect(
        (
          await fetch(`${registry.origin}/@tinta%2ffixture`, {
            method: "PUT",
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${registry.origin}/@tinta%2ffixture`, {
            headers: { authorization: "Bearer fixture" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await registry.close();
    }
  });
});
