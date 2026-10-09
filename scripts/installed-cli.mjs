import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { runCommandSync } from "./commands.mjs";
import { deploymentTemporaryRoot } from "./installed-cli-directory.mjs";

const root = process.cwd();
const directory = resolve("reports/verification/installed-cli");
mkdirSync(directory, { recursive: true });
const temporary = realpathSync(
  mkdtempSync(
    join(
      deploymentTemporaryRoot(process.platform, root, tmpdir()),
      "tinta-installed-",
    ),
  ),
);
const deployed = join(temporary, "package");
const consumer = join(temporary, "consumer");
const output = join(temporary, "checks á with spaces");
mkdirSync(consumer);
mkdirSync(output);
const report = { status: "IN_PROGRESS", commands: [], assertions: [] };

function save() {
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}

function check(name, pass) {
  report.assertions.push({ name, pass });
  save();
  if (!pass) throw new Error(name);
}

function run(command, { expected = 0, input, json = false } = {}) {
  const start = new Date().toISOString();
  const result = runCommandSync(command, { input });
  report.commands.push({
    command,
    cwd: process.cwd(),
    start,
    end: new Date().toISOString(),
    exitCode: result.status,
    expectedExitCode: expected,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  save();
  if (result.error || result.status !== expected)
    throw new Error(
      `Unexpected installed CLI result: ${JSON.stringify(report.commands.at(-1))}`,
    );
  if (!json) return result;
  const value = JSON.parse(result.stdout);
  if (typeof value?.ok !== "boolean" || value.ok !== (expected === 0))
    throw new Error("Invalid installed CLI JSON envelope");
  return value;
}

function cli(args, { json = true, ...options } = {}) {
  return run(
    [
      "pnpm",
      "--dir",
      consumer,
      "exec",
      "tinta",
      ...args,
      ...(json ? ["--json"] : []),
    ],
    { json, ...options },
  );
}

function hashes(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...hashes(path));
    else
      files.push([
        path,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
  }
  return files;
}

const example = (name) => join(root, "examples", name);
try {
  const before = hashes(example(""));
  run([
    "pnpm",
    "--filter",
    "@tinta/cli",
    "--config.inject-workspace-packages=true",
    "deploy",
    "--prod",
    "--offline",
    deployed,
  ]);
  const workspaceLock = parse(readFileSync("pnpm-lock.yaml", "utf8"));
  const deploymentLock = parse(
    readFileSync(join(deployed, "pnpm-lock.yaml"), "utf8"),
  );
  const registryPackages = Object.entries(deploymentLock.packages).filter(
    ([name]) => !name.includes("@file:"),
  );
  check(
    "Deployment preserves frozen registry versions and integrity",
    registryPackages.length > 0 &&
      registryPackages.every(
        ([name, entry]) =>
          JSON.stringify(entry.resolution) ===
          JSON.stringify(workspaceLock.packages[name]?.resolution),
      ),
  );
  run(["pnpm", "--dir", consumer, "link", deployed]);
  cli(["--help"], { json: false });
  const version = cli(["--version"], { json: false });
  check(
    "Installed version identifies the IR ABI",
    version.stdout.includes("tinta-ir-1"),
  );
  for (const name of [
    "article",
    "report",
    "guide",
    "chart-atlas",
    "minimal",
    "all-functions",
  ])
    cli(["check", example(`${name}.tinta`)]);
  const assets = cli(["check", example("local-image.tinta"), "--with-assets"]);
  check(
    "Asset check records explicit validation",
    assets.details.assetsChecked === true,
  );
  cli(["check", "-", "--profile", "tinta"], { input: "# Synthetic stdin\n" });
  cli(["check", "-"], { expected: 2, input: "# Synthetic stdin\n" });
  for (const format of ["interactive", "static"]) {
    const target = join(output, `article.${format}.html`);
    const args = [
      "build",
      example("article.tinta"),
      "--format",
      format,
      "--output",
      target,
    ];
    cli(args);
    const original = readFileSync(target);
    cli(args, { expected: 3 });
    check(
      `Existing ${format} output survives conflict`,
      readFileSync(target).equals(original),
    );
    cli([...args, "--force"]);
    cli([
      "build",
      example("article.tinta"),
      "--format",
      format,
      "--state",
      "snapshot",
      "--snapshot",
      example("article.tinta.state.json"),
      "--output",
      join(output, `snapshot.${format}.html`),
    ]);
  }
  const enriched = join(output, "enriched.tinta");
  cli(["enrich", example("import-before.md"), "--output", enriched]);
  cli(["check", enriched]);
  for (const [extension, text] of [
    ["csv", "name,count\nOne,2\nTwo,3\n"],
    ["json", '[{"name":"One","count":2},{"name":"Two","count":3}]'],
  ]) {
    const source = join(output, `rows.${extension}`);
    writeFileSync(source, text);
    const target = join(output, `from-${extension}.tinta`);
    const imported = cli([
      "import-data",
      source,
      "--name",
      "rows",
      "--output",
      target,
    ]);
    check(`${extension} import has two rows`, imported.details.rowCount === 2);
    cli(["check", target]);
    check(
      `${extension} input is preserved`,
      readFileSync(source, "utf8") === text,
    );
  }
  const bundle = join(output, "source.tinta.zip");
  const unpacked = join(output, "unpacked");
  cli(["pack", example("local-image.tinta"), "--output", bundle]);
  cli(["unpack", bundle, "--output-dir", unpacked]);
  check(
    "Unpack produces source and raster assets",
    existsSync(join(unpacked, "document.tinta")) &&
      readdirSync(join(unpacked, "assets")).length > 0,
  );
  cli(["check", join(unpacked, "document.tinta"), "--with-assets"]);
  cli(["unpack", bundle, "--output-dir", unpacked], { expected: 3 });
  cli(["check", bundle, "--profile", "markdown"], { expected: 2 });
  cli([
    "build",
    bundle,
    "--format",
    "interactive",
    "--output",
    join(output, "bundle.html"),
  ]);
  const invalid = join(output, "invalid.tinta");
  writeFileSync(invalid, "{{missing_name}}\n");
  cli(["check", invalid], { expected: 1 });
  cli(
    [
      "build",
      invalid,
      "--format",
      "static",
      "--output",
      join(output, "invalid.html"),
    ],
    { expected: 1 },
  );
  check(
    "Rejected source leaves no output",
    !existsSync(join(output, "invalid.html")),
  );
  cli(["check", example("article.tinta"), "--unknown"], { expected: 2 });
  const identity = join(output, "identity.tinta");
  writeFileSync(identity, readFileSync(example("article.tinta")));
  cli(
    ["build", identity, "--format", "static", "--output", identity, "--force"],
    { expected: 3 },
  );
  check(
    "Input/output identity rejection preserves source",
    readFileSync(identity).equals(readFileSync(example("article.tinta"))),
  );
  const located = cli(["studio"]);
  check(
    "Installed Studio resolves a local URI",
    located.details.uri.startsWith("file:"),
  );
  const studio = join(output, "tinta-studio.html");
  cli(["studio", "--output", studio]);
  check(
    "Installed Studio matches the built artifact",
    readFileSync(studio).equals(readFileSync("build/tinta-studio.html")),
  );
  for (const name of ["artifacts", "engine", "types"]) {
    const dependency = realpathSync(
      join(deployed, "node_modules", "@tinta", name),
    );
    const path = relative(temporary, dependency);
    check(
      `Installed ${name} is isolated from the workspace`,
      path !== ".." &&
        !path.startsWith(`..${sep}`) &&
        !resolve(dependency).startsWith(`${root}${sep}`),
    );
  }
  check(
    "Original examples remain unchanged",
    before.every(
      ([path, hash]) =>
        createHash("sha256").update(readFileSync(path)).digest("hex") === hash,
    ),
  );
  report.status = "PASS";
  console.log(
    `Installed CLI PASS: ${report.commands.length} commands and ${report.assertions.length} assertions`,
  );
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  save();
  cpSync(output, join(directory, "artifacts"), { recursive: true });
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
