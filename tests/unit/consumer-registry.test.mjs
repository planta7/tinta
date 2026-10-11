import { describe, it, expect } from "vitest";
import {
  loopbackRegistry,
  verifyIntegrity,
  startRegistry,
} from "../../scripts/consumer-registry.mjs";
import { createHash } from "node:crypto";

describe("sealed consumer registry", () => {
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
