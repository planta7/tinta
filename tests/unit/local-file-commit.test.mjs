import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWrite,
  identity,
  readAssets,
} from "../../packages/local-files/dist/index.js";

describe("shared file output commit guard", () => {
  it("rechecks host revisions after staging and leaves no temporary output", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinta-commit-"));
    try {
      const target = join(root, "output ñ.html");
      await writeFile(target, "PRIOR");
      const observed = await identity(target);
      await expect(
        atomicWrite(
          target,
          new TextEncoder().encode("CANDIDATE"),
          [],
          true,
          new AbortController().signal,
          () => {
            throw new Error("Source or answers changed");
          },
          observed,
        ),
      ).rejects.toThrow("changed");
      expect(await readFile(target, "utf8")).toBe("PRIOR");
      expect(await readdir(root)).toEqual(["output ñ.html"]);
      await writeFile(target, "COMPETING CHANGE");
      await expect(
        atomicWrite(
          target,
          new Uint8Array(),
          [],
          true,
          new AbortController().signal,
          undefined,
          observed,
        ),
      ).rejects.toThrow("Selected output changed");
      expect(await readFile(target, "utf8")).toBe("COMPETING CHANGE");
      const source = join(root, "input.tinta");
      await link(target, source);
      await expect(
        atomicWrite(
          target,
          new Uint8Array(),
          [source],
          true,
          new AbortController().signal,
        ),
      ).rejects.toThrow("replace an input");
      const controller = new AbortController();
      controller.abort();
      await expect(
        atomicWrite(target, new Uint8Array(), [], true, controller.signal),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit roots, rejects Windows author paths and honors cancellation", async () => {
    await expect(readAssets(["image.png"], undefined)).rejects.toMatchObject({
      code: "E_ASSET_MISSING",
    });
    for (const [path, code] of [
      ["C:/secret.png", "E_ASSET_EXTERNAL"],
      ["C:\\secret.png", "E_ASSET_EXTERNAL"],
      ["\\\\server\\share\\secret.png", "E_ASSET_PATH"],
      ["../secret.png", "E_ASSET_PATH"],
    ]) {
      await expect(readAssets([path], process.cwd())).rejects.toMatchObject({
        code,
      });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      readAssets(["image.png"], process.cwd(), controller.signal),
    ).rejects.toThrow();
  });
});
