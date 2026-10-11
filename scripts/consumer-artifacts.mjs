import { parse as parseYaml } from "yaml";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  realpath,
  copyFile,
} from "node:fs/promises";
import { tmpdir, platform, arch, release, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  digest,
  readTarball,
  readZip,
  safePath,
} from "./distribution-archive.mjs";
import { consumerTools } from "./consumer-dependencies.mjs";
import {
  registryPackages,
  startRegistry,
  loopbackRegistry,
  verifyIntegrity,
} from "./consumer-registry.mjs";
import { testConsumerBrowsers } from "./consumer-browsers.mjs";
import { isInsideDirectory } from "./consumer-paths.mjs";

const [inventoryFile, dependencyDirectory, reportFile] = process.argv.slice(2);
if (!reportFile)
  throw new Error(
    "Pass supplied inventory.json, dependency directory and report.json. Archives are never rebuilt.",
  );
const inventoryPath = resolve(inventoryFile);
const archives = dirname(inventoryPath);
const inventory = JSON.parse(await readFile(inventoryPath));
const workspace = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "tinta-consumer-")),
);
assert.ok(
  !isInsideDirectory(workspace, temporary),
  "Consumer must be outside the workspace",
);
const corepackHome =
  process.env.COREPACK_HOME ??
  join(
    process.env.XDG_CACHE_HOME ??
      process.env.LOCALAPPDATA ??
      join(
        homedir(),
        process.platform === "win32" ? "AppData/Local" : ".cache",
      ),
    "node/corepack",
  );
const pnpmCli =
  process.env.TINTA_CONSUMER_PNPM ??
  join(corepackHome, "v1/pnpm/10.34.6/bin/pnpm.cjs");
const report = {
  status: "RUNNING",
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  node: process.version,
  pnpmCliSha256: digest(await readFile(pnpmCli)),
  inventorySha256: digest(await readFile(inventoryPath)),
  source: inventory.source,
  temporary,
  archives: [],
  commands: [],
  routes: [],
  limitations: [
    "Current native OS/architecture only; browser offline contexts are not system-wide network isolation.",
  ],
};
await mkdir(dirname(resolve(reportFile)), { recursive: true });
const save = () =>
  writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
async function run(command, cwd, env, expected = 0) {
  const result = {
    command,
    cwd,
    expected,
    started: new Date().toISOString(),
    stdout: "",
    stderr: "",
  };
  report.commands.push(result);
  await new Promise((accept, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      shell: false,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (bytes) => {
      result.stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      result.stderr += bytes;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      result.exitCode = code;
      accept();
    });
  });
  await save();
  assert.equal(result.exitCode, expected, JSON.stringify(result));
  return result;
}
let registry;
try {
  assert.equal(process.versions.node, "24.21.0");
  const ids = [
    "types",
    "syntax",
    "engine",
    "charts",
    "reader",
    "artifacts",
    "local-files",
    "cli",
    "language-service",
    "language-server",
    "vscode",
    "studio-directory",
    "studio-standalone",
    "reader-runtime",
    "source",
    "examples",
  ];
  assert.deepEqual(inventory.targets.map((item) => item.id).sort(), ids.sort());
  for (const target of inventory.targets) {
    safePath(target.archive);
    const bytes = await readFile(join(archives, target.archive));
    assert.equal(digest(bytes), target.sha256);
    verifyIntegrity(bytes, target.integrity);
    assert.equal(bytes.length, target.bytes);
    const entries = target.archive.endsWith(".tgz")
      ? readTarball(bytes)
      : readZip(bytes);
    assert.deepEqual(
      Object.keys(entries).sort(),
      target.files.map((file) => file.path).sort(),
    );
    for (const file of target.files)
      assert.equal(digest(entries[file.path]), file.sha256);
    report.archives.push({
      id: target.id,
      sha256: target.sha256,
      bytes: bytes.length,
    });
  }
  const tools = await consumerTools();
  report.tools = tools;
  const packages = await registryPackages(
    inventory,
    archives,
    dependencyDirectory,
    tools,
  );
  registry = await startRegistry(packages);
  loopbackRegistry(registry.origin);
  const manifests = packages
    .filter((item) => item.manifest.name.startsWith("@tinta/"))
    .map((item) => item.manifest);
  const downloads = join(temporary, "downloads");
  for (const target of inventory.targets.filter((item) =>
    [
      "studio-directory",
      "studio-standalone",
      "reader-runtime",
      "examples",
    ].includes(item.id),
  )) {
    const entries = readZip(await readFile(join(archives, target.archive)));
    for (const [path, bytes] of Object.entries(entries)) {
      safePath(path);
      const output = join(downloads, target.id, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
  }
  for (const manager of ["npm", "pnpm"]) {
    const directory = join(temporary, manager);
    await mkdir(join(directory, "home"), { recursive: true });
    await writeFile(join(directory, "empty-config"), "");
    await writeFile(join(directory, "empty-global-config"), "");
    const env = {
      PATH: process.env.PATH,
      HOME: join(directory, "home"),
      USERPROFILE: join(directory, "home"),
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC }
        : {}),
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      NODE_PATH: "",
      NODE_OPTIONS: "",
      CI: "true",
      npm_config_userconfig: join(directory, "empty-config"),
      npm_config_globalconfig: join(directory, "empty-global-config"),
      npm_config_cache: join(directory, "cache"),
      npm_config_registry: registry.origin,
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    await writeFile(
      join(directory, ".npmrc"),
      `registry=${registry.origin}/\n@tinta:registry=${registry.origin}/\nignore-scripts=true\naudit=false\nfund=false\n`,
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: "tinta-consumer-check",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies: Object.fromEntries([
            ...manifests.map((item) => [item.name, item.version]),
            ...tools.map((item) => [item.name, item.version]),
          ]),
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(directory, "manifests.json"),
      JSON.stringify(manifests),
    );
    for (const name of ["probe.mjs", "parser.mjs", "ipc-watchdog.mjs"])
      await copyFile(
        new URL(`../tests/consumer/${name}`, import.meta.url),
        join(directory, name),
      );
    const image = Object.entries(
      readZip(
        await readFile(
          join(
            archives,
            inventory.targets.find((item) => item.id === "examples").archive,
          ),
        ),
      ),
    ).find(([name]) => name.endsWith(".png"));
    assert.ok(image, "Examples must contain a raster resource");
    await writeFile(join(directory, "photo.png"), image[1]);
    const managerCommand =
      manager === "pnpm"
        ? [process.execPath, pnpmCli]
        : process.env.TINTA_NPM_CLI
          ? [process.execPath, process.env.TINTA_NPM_CLI]
          : ["npm"];
    const version = await run([...managerCommand, "--version"], directory, env);
    assert.equal(
      version.stdout.trim(),
      manager === "npm" ? "11.19.0" : "10.34.6",
    );
    await run(
      [
        ...managerCommand,
        "install",
        "--ignore-scripts",
        ...(manager === "pnpm"
          ? [
              "--store-dir",
              join(directory, "store"),
              "--config.node-linker=isolated",
              "--config.hoist=false",
              "--config.shamefully-hoist=false",
            ]
          : ["--install-strategy=nested"]),
      ],
      directory,
      env,
    );
    const lock = await readFile(
      join(
        directory,
        manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
      ),
      "utf8",
    );
    const lockData = manager === "npm" ? JSON.parse(lock) : parseYaml(lock);
    function checkResolved(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (["resolved", "tarball"].includes(key))
          assert.ok(
            entry.startsWith(registry.origin + "/"),
            "Non-loopback dependency resolution",
          );
        else checkResolved(entry);
      }
    }
    checkResolved(lockData);
    const requestsBeforeProcessing = registry.requests.length;
    await run([process.execPath, "probe.mjs"], directory, env);
    assert.equal(
      registry.requests.length,
      requestsBeforeProcessing,
      "Document processing accessed the registry",
    );
    const result = JSON.parse(
      await readFile(join(directory, "probe-result.json")),
    );
    const syntax = await realpath(
      join(directory, "node_modules/@tinta/syntax/dist/index.js"),
    );
    const original = await readFile(syntax, "utf8");
    const hooks = original.match(/observeTokenizer\?\.\([^;]+;/g);
    assert.equal(hooks?.length, 2, "Unexpected bundled tokenizer hook layout");
    try {
      await writeFile(
        syntax,
        original.replace(/observeTokenizer\?\.\([^;]+;/g, ""),
      );
      const negative = await run(
        [process.execPath, "parser.mjs", "--installed"],
        directory,
        env,
        1,
      );
      assert.match(
        negative.stderr,
        /Missing ordinary Markdown tokenizer budget hook/,
      );
    } finally {
      await writeFile(syntax, original);
    }
    await run([process.execPath, "parser.mjs", "--installed"], directory, env);
    result.negativeUnpatchedHook =
      "PASS: removing both upstream tokenizer hooks is detected";
    for (const target of inventory.targets.filter((item) =>
      item.archive.endsWith(".tgz"),
    )) {
      const root = await realpath(
        join(directory, "node_modules/@tinta", target.id),
      );
      assert.ok(isInsideDirectory(directory, root));
      for (const file of target.files)
        assert.equal(
          digest(await readFile(join(root, file.path))),
          file.sha256,
          `Installed bytes changed: ${target.id}/${file.path}`,
        );
    }
    result.installedPayloadHashes =
      "PASS: every installed package file matches its supplied archive";
    result.manager = manager;
    report.routes.push(result);
    await save();
  }
  report.registryRequests = registry.requests;
  await registry.close();
  registry = undefined;
  report.browsers = await testConsumerBrowsers(temporary);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (registry) {
    report.registryRequests = registry.requests;
    await registry.close();
  }
  await save();
}
console.log(
  JSON.stringify({
    status: report.status,
    report: resolve(reportFile),
    temporary,
  }),
);
