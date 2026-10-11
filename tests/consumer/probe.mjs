import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { fork, spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIpcWatchdog } from "./ipc-watchdog.mjs";
import { checkParser } from "./parser.mjs";

const manifests = JSON.parse(await readFile("manifests.json"));
const groups = [];
const commands = [];
const declarations = [];
const inside = (path) => {
  const rel = relative(process.cwd(), path);
  assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`));
};
for (const manifest of manifests) {
  for (const [key, value] of Object.entries(manifest.exports)) {
    const specifier = manifest.name + (key === "." ? "" : key.slice(1));
    const path = fileURLToPath(import.meta.resolve(specifier));
    inside(await realpath(path));
    assert.ok((await readFile(path)).length > 0);
    if (key !== "./ipc" && !key.endsWith(".css")) {
      await import(specifier);
      assert.ok(value.types, `Missing declaration export: ${specifier}`);
      declarations.push(
        `import * as api${declarations.length} from ${JSON.stringify(specifier)};\nexport type Api${declarations.length} = typeof api${declarations.length};`,
      );
    }
    groups.push(`export:${specifier}`);
  }
}
await writeFile("exports.ts", declarations.join("\n") + "\n");
await writeFile(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node"],
    },
    files: ["exports.ts"],
  }),
);
const typecheck = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  { encoding: "utf8" },
);
commands.push({
  command: [
    process.execPath,
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.json",
  ],
  exitCode: typecheck.status,
  stdout: typecheck.stdout,
  stderr: typecheck.stderr,
});
assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
groups.push("declarations:strict-node-next");
checkParser(await import("@tinta/syntax"));
groups.push("parser:budget-depth-recovery-spans");
const { compile, createSession } = await import("@tinta/engine");
const source = `@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")

Value: {{ amount }}

![Photo](photo.png)
`;
const input = { text: source, profile: "tinta", uri: "tinta:consumer" };
const program = compile(input);
assert.equal(program.ok, true);
const session = createSession(program.value);
assert.equal(session.ok, true);
assert.equal(session.value.getRevision().state.amount, 2);
assert.equal(session.value.setControl("amount", 3).ok, true);
assert.equal(session.value.getRevision().values.amount, 3);
assert.equal(session.value.reset().ok, true);
assert.equal(session.value.getRevision().state.amount, 2);
session.value.destroy();
groups.push("engine:compile-evaluate");
const { analyze, completion, definition } =
  await import("@tinta/language-service");
const analysis = analyze(input, {
  documentInstance: "a".repeat(32),
  editorVersion: 1,
  sourceRevision: 0,
});
assert.equal(analysis.ok, true);
assert.equal(analysis.value.validity, "valid");
assert.ok(definition(analysis.value, source.indexOf("{{ amount") + 4));
assert.ok(
  completion(
    analysis.value,
    source.indexOf("{{ amount") + 4,
  ).allowedNames.includes("amount"),
);
groups.push("language-service:queries");
const child = fork(
  fileURLToPath(import.meta.resolve("@tinta/language-server/ipc")),
  [],
  {
    cwd: process.cwd(),
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let errors = "";
child.stderr.on("data", (bytes) => {
  errors += bytes;
});
try {
  const status = await new Promise((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error("IPC worker timed out")),
      10000,
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`IPC exit ${code}: ${errors}`)),
    );
    child.on("message", (message) => {
      if (message.id === 1) {
        try {
          assert.equal(message.result.capabilities.positionEncoding, "utf-16");
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        child.send({ jsonrpc: "2.0", method: "initialized", params: {} });
        child.send({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri: "file:///consumer.tinta",
              languageId: "tinta",
              version: 1,
              text: source,
            },
          },
        });
      }
      if (message.method === "tinta/status") {
        clearTimeout(timer);
        accept(message.params);
      }
    });
    child.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: process.pid, capabilities: {}, rootUri: null },
    });
  });
  assert.equal(status.source, "valid");
  assert.equal(status.fidelity, "unverified");
  assert.equal(status.assets, "not-checked");
} finally {
  child.kill();
}
groups.push("ipc:server-worker-handshake");
await checkIpcWatchdog(
  fileURLToPath(import.meta.resolve("@tinta/language-server/ipc")),
  join(process.cwd(), "watchdog"),
);
groups.push("ipc:watchdog-restart-production-worker");
await writeFile("document.tinta", source);
const cliPath = join(process.cwd(), "node_modules/.bin/tinta");
function cli(args, expected = 0) {
  const result = spawnSync(cliPath, [...args, "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  commands.push({
    command: [cliPath, ...args, "--json"],
    exitCode: result.status,
    expectedExitCode: expected,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
assert.equal(
  cli(["check", "document.tinta", "--with-assets"]).details.assetsChecked,
  true,
);
for (const format of ["static", "interactive"]) {
  cli([
    "build",
    "document.tinta",
    "--format",
    format,
    "--output",
    `${format}.html`,
  ]);
  assert.match(await readFile(`${format}.html`, "utf8"), /image\/png/);
  cli(
    [
      "build",
      "document.tinta",
      "--format",
      format,
      "--output",
      `${format}.html`,
    ],
    3,
  );
}
cli(["pack", "document.tinta", "--output", "document.tinta.zip"]);
cli(["unpack", "document.tinta.zip", "--output-dir", "unpacked"]);
cli(["check", "unpacked/document.tinta", "--with-assets"]);
cli(["studio", "--output", "tinta-studio.html"]);
const located = cli(["studio"]);
inside(await realpath(fileURLToPath(located.details.uri)));
const { readOpenedSource, resolveAssets } = await import("@tinta/local-files");
assert.equal(
  Buffer.from(await readOpenedSource("document.tinta")).toString(),
  source,
);
assert.equal(typeof resolveAssets, "function");
await writeFile("escape.tinta", "![Outside](../outside.png)\n");
assert.equal(
  cli(["check", "escape.tinta", "--with-assets"], 1).diagnostics[0].code,
  "E_ASSET_PATH",
);
groups.push("cli:images-grants-exports-bundle-studio");
await writeFile(
  "probe-result.json",
  JSON.stringify({ status: "PASS", groups, commands }, null, 2) + "\n",
);
console.log(JSON.stringify({ status: "PASS", groups }));
