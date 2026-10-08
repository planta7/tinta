import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  cp,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  link,
  chmod,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../../packages/cli/dist/index.js";
import { atomicWrite } from "../../packages/cli/dist/files.js";
let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tinta-cli-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const json = async (args) => {
  const result = await run([...args, "--json"]);
  expect(result.stderr).toBe("");
  return { ...result, value: JSON.parse(result.stdout) };
};
describe("command arguments", () => {
  test("help, version and actual workspace bin", () => {
    for (const arg of ["--help", "--version"]) {
      const args = ["--filter", "@tinta/cli", "exec", "tinta", arg];
      const result =
        process.platform === "win32"
          ? spawnSync("cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], {
              encoding: "utf8",
            })
          : spawnSync("pnpm", args, { encoding: "utf8" });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(
        arg === "--version" ? "tinta-ir-1" : "Usage:",
      );
    }
  });
  test.each(
    [
      [],
      ["unknown"],
      ["check"],
      ["check", "x", "--unknown"],
      ["check", "x", "--prof=tinta"],
      ["check", "x", "-j"],
      ["check", "x", "--no-json"],
      ["check", "x", "--profile="],
      ["check", "x", "--json", "--json"],
      ["check", "x", "--profile"],
      ["check", "x", "--profile=tinta", "--profile=markdown"],
      ["check", "x.tinta", "--asset-root", "."],
      ["build", "x.tinta", "--output", "x.html"],
      [
        "build",
        "x.tinta",
        "--format",
        "static",
        "--output",
        "x.html",
        "--state",
        "snapshot",
      ],
      [
        "build",
        "x.tinta",
        "--format",
        "static",
        "--output",
        "x.html",
        "--snapshot",
        "s.json",
      ],
      ["pack", "-", "--output", "x.zip"],
      ["enrich", "x.tinta", "--output", "x.md"],
      ["studio", "--force"],
      ["check", "x.tinta", "--json=false"],
    ].map((args) => ({ args })),
  )("rejects invalid usage $args", async ({ args }) =>
    expect((await run(args)).exitCode).toBe(2),
  );
  test("accepts equal-valued flags, Unicode paths and operand terminator", async () => {
    const input = join(directory, "á source.md");
    await writeFile(input, "# Unicode\n");
    const result = await json(["check", "--profile=markdown", "--", input]);
    // --json after the operand terminator is intentionally an operand.
    expect(result.exitCode).toBe(2);
    const valid = await run([
      "check",
      "--json",
      "--profile=markdown",
      "--",
      input,
    ]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout).details.assetsChecked).toBe(false);
  });
});
describe("local document commands", () => {
  test("check validates evaluation and warnings without implicitly loading images", async () => {
    const input = join(directory, "source.tinta");
    await writeFile(input, "# Source\n\n![x](absent.png)\n");
    expect((await json(["check", input])).value.details.assetsChecked).toBe(
      false,
    );
    expect((await json(["check", input, "--with-assets"])).exitCode).toBe(1);
    await writeFile(input, "<script>alert(1)</script>\n");
    expect((await json(["check", input])).exitCode).toBe(0);
    const warning = await json(["check", input, "--warnings-as-errors"]);
    expect(warning.exitCode).toBe(1);
    expect(warning.value.diagnostics[0].severity).toBe("warning");
  });
  test("enrich preserves original and refuses every alias even with force", async () => {
    const input = join(directory, "source.md"),
      output = join(directory, "result.tinta");
    const text = "# Text\n\nLiteral {{ value }}.\n";
    await writeFile(input, text);
    expect((await json(["enrich", input, "--output", output])).exitCode).toBe(
      0,
    );
    expect(await readFile(input, "utf8")).toBe(text);
    expect(await readFile(output, "utf8")).toContain("\\{{");
    for (const alias of [
      input,
      join(directory, "symlink.tinta"),
      join(directory, "hardlink.tinta"),
    ]) {
      if (alias.includes("symlink")) await symlink(input, alias);
      if (alias.includes("hardlink")) await link(input, alias);
      expect(
        (await json(["enrich", input, "--output", alias, "--force"])).exitCode,
      ).toBe(3);
    }
    expect(await readFile(input, "utf8")).toBe(text);
  });
  test("build rejects conflicts, preserves output on invalid input and replaces atomically", async () => {
    const input = join(directory, "source.tinta"),
      output = join(directory, "output.html");
    await writeFile(input, "# Valid\n");
    await writeFile(output, "OLD");
    const args = ["build", input, "--format", "static", "--output", output];
    expect((await json(args)).exitCode).toBe(3);
    await writeFile(input, "@calc broken = unknown\n");
    expect((await json([...args, "--force"])).exitCode).toBe(1);
    expect(await readFile(output, "utf8")).toBe("OLD");
    await writeFile(input, "# Valid\n");
    expect((await json([...args, "--force"])).exitCode).toBe(0);
    expect(await readFile(output, "utf8")).toContain("<h1");
    await chmod(output, 0o444);
    expect((await json([...args, "--force"])).exitCode).toBe(3);
    await chmod(output, 0o600);
    expect(
      (await readdir(directory)).some((path) => path.endsWith(".tmp")),
    ).toBe(false);
  });
  test("pack and unpack validate resources before writing and reject existing directories", async () => {
    const output = join(directory, "bundle.tinta.zip"),
      target = join(directory, "opened");
    expect(
      (
        await json([
          "pack",
          resolve("examples/local-image.tinta"),
          "--output",
          output,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (await json(["unpack", output, "--output-dir", target])).exitCode,
    ).toBe(0);
    expect(await readdir(target)).toContain("document.tinta");
    expect(
      (await json(["unpack", output, "--output-dir", target])).exitCode,
    ).toBe(3);
    expect(
      (await json(["check", output, "--profile", "markdown"])).exitCode,
    ).toBe(2);
    expect(
      (
        await json([
          "build",
          output,
          "--format",
          "interactive",
          "--output",
          join(directory, "bundle.html"),
        ])
      ).exitCode,
    ).toBe(0);
  });
  test("image root grants reject symlink escapes", async () => {
    const root = join(directory, "root");
    await mkdir(root);
    const image = resolve(
      "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
    );
    await symlink(image, join(root, "photo.png"));
    const input = join(root, "source.tinta");
    await writeFile(input, "![x](photo.png)\n");
    const result = await json(["check", input, "--with-assets"]);
    expect(result.exitCode).toBe(1);
    expect(result.value.diagnostics.at(-1).code).toBe("E_ASSET_PATH");
  });
  test.each(["csv", "json"])(
    "imports %s into a compilable fragment",
    async (extension) => {
      const input = join(directory, `rows.${extension}`),
        output = join(directory, "rows.tinta");
      await writeFile(
        input,
        extension === "csv"
          ? "name,count\nOne,2\n"
          : '[{"name":"One","count":2}]',
      );
      const result = await json([
        "import-data",
        input,
        "--name",
        "rows",
        "--output",
        output,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.value.details.rowCount).toBe(1);
      expect((await json(["check", output])).exitCode).toBe(0);
    },
  );
  test("missing production Studio fails explicitly without using the scaffold", async () => {
    const isolated = join(directory, "isolated-cli");
    await mkdir(isolated);
    await cp("packages/cli/dist", join(isolated, "dist"), { recursive: true });
    await writeFile(join(isolated, "package.json"), '{"type":"module"}');
    await symlink(
      resolve("packages/cli/node_modules"),
      join(isolated, "node_modules"),
      "junction",
    );
    const result = spawnSync(
      process.execPath,
      [join(isolated, "dist/bin.js"), "studio", "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).artifacts).toEqual([]);
  });
  test("production Studio resolves and copies exact standalone bytes", async () => {
    const located = await json(["studio"]);
    expect(located.exitCode).toBe(0);
    expect(located.value.details.uri).toMatch(/^file:/);
    const output = join(directory, "studio.html");
    const copied = await json(["studio", "--output", output]);
    expect(copied.exitCode).toBe(0);
    expect(
      Buffer.compare(
        await readFile(output),
        await readFile("build/tinta-studio.html"),
      ),
    ).toBe(0);
    expect(await readFile(output, "utf8")).toContain("Tinta Studio");
  });
  test("aborting an atomic write preserves old content and removes its staging file", async () => {
    const output = join(directory, "keep.html");
    await writeFile(output, "ORIGINAL");
    const controller = new AbortController();
    controller.abort();
    await expect(
      atomicWrite(
        output,
        Buffer.from("replacement"),
        [],
        true,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("ORIGINAL");
    expect(await readdir(directory)).toEqual(["keep.html"]);
  });
});

test("import schema is strict, complete and does not silently coerce JSON", async () => {
  const input = join(directory, "rows.json"),
    schema = join(directory, "schema.json"),
    output = join(directory, "result.tinta");
  await writeFile(input, '[{"value":2}]');
  await writeFile(
    schema,
    JSON.stringify({
      kind: "tinta-import-schema",
      columns: [{ input: "value", name: "renamed", type: "text" }],
    }),
  );
  expect(
    (
      await json([
        "import-data",
        input,
        "--name",
        "rows",
        "--schema",
        schema,
        "--output",
        output,
      ])
    ).exitCode,
  ).toBe(0);
  expect(await readFile(output, "utf8")).toContain("renamed:text");
  for (const value of [
    { kind: "wrong", columns: [] },
    {
      kind: "tinta-import-schema",
      columns: [{ input: "value", name: "renamed", type: "wrong" }],
    },
    {
      kind: "tinta-import-schema",
      columns: [{ input: "absent", name: "renamed", type: "number" }],
    },
    {
      kind: "tinta-import-schema",
      columns: [
        {
          input: "value",
          name: "renamed",
          type: "number",
          extra: true,
        },
      ],
    },
  ]) {
    await writeFile(schema, JSON.stringify(value));
    expect(
      (
        await json([
          "import-data",
          input,
          "--name",
          "rows",
          "--schema",
          schema,
          "--output",
          output,
          "--force",
        ])
      ).exitCode,
    ).toBe(1);
  }
});
test("snapshot builds preserve source identity and reject changed sources", async () => {
  const input = join(directory, "source.tinta"),
    snapshot = join(directory, "answers.tinta.state.json"),
    output = join(directory, "result.html");
  const text = "@slider value = 1 (min: 0, max: 3)\n\nValue: {{value}}\n";
  await writeFile(input, text);
  const { compile, createSession } =
    await import("../../packages/engine/dist/index.js");
  const { unwrap, createStateSnapshot } =
    await import("../../packages/artifacts/dist/index.js");
  const session = unwrap(
    createSession(
      unwrap(compile({ text, profile: "tinta", uri: "tinta:test" })),
    ),
  );
  unwrap(session.setControl("value", 3));
  await writeFile(snapshot, JSON.stringify(createStateSnapshot(session)));
  session.destroy();
  const args = [
    "build",
    input,
    "--format",
    "static",
    "--state",
    "snapshot",
    "--snapshot",
    snapshot,
    "--output",
    output,
  ];
  expect((await json(args)).exitCode).toBe(0);
  expect(await readFile(output, "utf8")).toContain("Value: 3");
  await writeFile(input, text + "\n");
  expect((await json([...args, "--force"])).exitCode).toBe(1);
  expect(await readFile(output, "utf8")).toContain("Value: 3");
});
test.each(
  [
    ["check", "-"],
    ["check", "source.unknown"],
    ["check", "x", "--profile=invalid"],
    ["check", "--profile=tinta", "x", "y"],
    ["check", "--profile=tinta", "-z"],
    [
      "build",
      "source.md",
      "--format=static",
      "--state=snapshot",
      "--snapshot=x",
      "--output=x.html",
    ],
    ["build", "x.tinta", "--format=pdf", "--output=x.html"],
    [
      "build",
      "x.tinta",
      "--format=static",
      "--state=current",
      "--output=x.html",
    ],
    ["pack", "x.md", "--output=x.zip"],
    ["unpack", "x.md", "--output-dir=x"],
    ["import-data", "x.xml", "--name=rows", "--output=x.tinta"],
  ].map((args) => ({ args })),
)("rejects command-specific invalid options $args", async ({ args }) =>
  expect((await json(args)).exitCode).toBe(2),
);

test("malformed UTF-8 snapshot and import schema are validation errors", async () => {
  const source = join(directory, "source.tinta");
  const data = join(directory, "source.csv");
  const invalid = join(directory, "invalid.json");
  const output = join(directory, "output.html");
  await writeFile(source, "# Source\n");
  await writeFile(data, "value\n1\n");
  await writeFile(invalid, Buffer.from([0xff]));
  for (const args of [
    [
      "build",
      source,
      "--format=static",
      "--state=snapshot",
      "--snapshot",
      invalid,
    ],
    ["import-data", data, "--name=rows", "--schema", invalid],
  ]) {
    const result = await json([...args, "--output", output]);
    expect(result.exitCode).toBe(1);
    expect(result.value.diagnostics[0].code).toBe("E_ENCODING");
    expect(await readdir(directory)).not.toContain("output.html");
  }
});
