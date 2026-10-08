import { test, expect, vi, afterEach } from "vitest";
import { Readable } from "node:stream";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, main } from "../../packages/cli/dist/index.js";
import {
  readBounded,
  atomicWrite,
  unpackTree,
  assertOutput,
} from "../../packages/cli/dist/files.js";
const faults = vi.hoisted(() => ({ point: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    link: async (temporary, target) => {
      if (faults.point === "concurrent-target")
        await actual.writeFile(target, "CONCURRENT FILE", { flag: "wx" });
      return actual.link(temporary, target);
    },
    rename: async (...args) => {
      if (faults.point === "rename")
        throw Object.assign(new Error("Injected commit failure"), {
          code: "EACCES",
        });
      return actual.rename(...args);
    },
    open: async (...args) => {
      const handle = await actual.open(...args);
      if (!String(args[0]).endsWith(".tmp")) return handle;
      return {
        close: () => handle.close(),
        writeFile: async (...values) => {
          if (faults.point === "write")
            throw Object.assign(new Error("Injected disk failure"), {
              code: "ENOSPC",
            });
          return handle.writeFile(...values);
        },
        sync: async () => {
          if (faults.point === "sync")
            throw Object.assign(new Error("Injected sync failure"), {
              code: "EIO",
            });
          return handle.sync();
        },
      };
    },
  };
});
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  faults.point = "";
  Object.defineProperty(process, "stdin", originalStdin);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});
const input = (chunks) =>
  Object.defineProperty(process, "stdin", {
    value: Readable.from(chunks),
    configurable: true,
  });
test("stdin check/build/enrich require no implicit root and preserve JSON output", async () => {
  input([Buffer.from("# Input\n")]);
  const checked = await run(["check", "-", "--profile=markdown", "--json"]);
  expect(checked.exitCode).toBe(0);
  expect(JSON.parse(checked.stdout).details.profile).toBe("markdown");
  const folder = await mkdtemp(join(tmpdir(), "tinta-stdin-"));
  try {
    input([Buffer.from("Literal {{ text }}\n")]);
    expect(
      (await run(["enrich", "-", "--output", join(folder, "source.tinta")]))
        .exitCode,
    ).toBe(0);
    input([Buffer.from("![x](photo.png)\n")]);
    expect(
      (
        await run([
          "build",
          "-",
          "--profile=tinta",
          "--format=interactive",
          "--output",
          join(folder, "source.html"),
        ])
      ).exitCode,
    ).toBe(1);
    input([Buffer.alloc(2097153, 97)]);
    expect((await run(["check", "-", "--profile=tinta"])).exitCode).toBe(1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test("main forwards result and removes signal listener", async () => {
  const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true),
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.argv = ["node", "tinta", "--version"];
  const before = process.listenerCount("SIGINT");
  await main();
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("tinta-ir-1"));
  expect(stderr).toHaveBeenCalledWith("");
  expect(process.listenerCount("SIGINT")).toBe(before);
  process.argv = ["node", "tinta", "--help"];
  await import("../../packages/cli/dist/bin.js");
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
});
test("SIGINT returns 130 and never creates output", async () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  input(
    (async function* () {
      yield Buffer.from("# A");
      process.emit("SIGINT");
      yield Buffer.from("# B");
    })(),
  );
  process.argv = ["node", "tinta", "check", "-", "--profile=tinta", "--json"];
  await main();
  expect(process.exitCode).toBe(130);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
});
for (const point of ["write", "sync", "rename"])
  test(`injected ${point} failure preserves pre-existing output`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "tinta-atomic-"));
    try {
      const source = join(folder, "source.tinta"),
        output = join(folder, "keep.html");
      await writeFile(source, "# Safe\n");
      await writeFile(output, "ORIGINAL");
      faults.point = point;
      const result = await run([
        "build",
        source,
        "--format=static",
        "--output",
        output,
        "--force",
        "--json",
      ]);
      expect(result.exitCode).toBe(3);
      expect(await readFile(output, "utf8")).toBe("ORIGINAL");
      expect((await readdir(folder)).sort()).toEqual([
        "keep.html",
        "source.tinta",
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
test("bounded host reads reject directories and excessive bytes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tinta-bounds-"));
  try {
    await expect(readBounded(folder, 10)).rejects.toThrow();
    const file = join(folder, "file");
    await writeFile(file, "12345");
    await expect(readBounded(file, 4)).rejects.toThrow();
    const directory = join(folder, "directory");
    await mkdir(directory);
    await expect(assertOutput(directory, [], true)).rejects.toThrow();
    await expect(
      atomicWrite(
        join(folder, "missing", "file"),
        Buffer.from("x"),
        [],
        false,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      unpackTree(
        join(folder, "unpacked"),
        new Map([["document.tinta", Buffer.from("x")]]),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(folder)).not.toContain("unpacked");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a concurrently created destination survives a new-output commit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tinta-race-"));
  try {
    const source = join(folder, "source.tinta");
    const output = join(folder, "output.html");
    await writeFile(source, "# Safe\n");
    faults.point = "concurrent-target";
    const result = await run([
      "build",
      source,
      "--format=static",
      "--output",
      output,
      "--json",
    ]);
    expect(result.exitCode).toBe(3);
    expect(await readFile(output, "utf8")).toBe("CONCURRENT FILE");
    expect((await readdir(folder)).sort()).toEqual([
      "output.html",
      "source.tinta",
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
