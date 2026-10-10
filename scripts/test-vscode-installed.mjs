import { build } from "esbuild";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { driveInstalledUI } from "./vscode-installed-ui.mjs";
import { inspectPackage } from "./vscode-package.mjs";

const [executable, cli, archive, directory, ...flags] = process.argv.slice(2);
if (!directory)
  throw new Error(
    "Pass desktop executable, CLI executable, VSIX and fresh temporary directory.",
  );
const root = resolve(directory);
const restricted = flags.includes("--restricted");
const performance = flags.includes("--performance");
const workflow = flags.includes("--workflow");
const osOffline = flags.includes("--os-offline");
if (osOffline && process.platform !== "darwin")
  throw new Error("OS network isolation is unavailable on this platform.");
const port = Number(process.env.TINTA_TEST_DEBUG_PORT ?? 9338);
const release = flags.includes("--release");
const inspection = inspectPackage(await readFile(archive), { release });
await mkdir(root);
await copyFile(archive, join(root, "tinta.vsix"));
await mkdir(join(root, "harness"));
await mkdir(join(root, "portable"));
await mkdir(join(root, "workspace"));
await copyFile(
  "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
  join(root, "workspace/photo.png"),
);
await mkdir(join(root, "portable/user-data/User"), { recursive: true });
await writeFile(
  join(root, "portable/user-data/User/settings.json"),
  JSON.stringify({
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "workbench.startupEditor": "none",
    "chat.disableAIFeatures": true,
    "files.autoSave": "off",
    "files.simpleDialog.enable": true,
    "window.dialogStyle": "custom",
    "security.workspace.trust.startupPrompt": "never",
    "security.workspace.trust.emptyWindow": !restricted,
  }),
);
await writeFile(
  join(root, "harness/package.json"),
  JSON.stringify({
    name: "installed-host-tests",
    publisher: "tinta-local",
    version: "0.0.0",
    engines: { vscode: "^1.141.0" },
    main: "./extension.cjs",
    activationEvents: ["*"],
    capabilities: { untrustedWorkspaces: { supported: true } },
  }),
);
await writeFile(
  join(root, "harness/extension.cjs"),
  workflow
    ? `exports.activate = async () => {
  try {
    await require("../tests.cjs").run();
  } finally {
    require("vscode").commands.executeCommand("workbench.action.quit");
  }
};
`
    : "exports.activate = () => {};\n",
);
await build({
  entryPoints: ["tests/vscode/installed.mjs"],
  outfile: join(root, "tests.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  sourcemap: false,
});
const env = {
  ...process.env,
  NODE_PATH: "",
  VSCODE_PORTABLE: join(root, "portable"),
  TINTA_INSTALLED_ROOT: root,
  TINTA_INSTALLED_ID: inspection.extensionId,
  TINTA_INSTALLED_VERSION: inspection.identity.extensionVersion,
  TINTA_INSTALLED_WORKFLOW: String(workflow),
  TINTA_INSTALLED_PERFORMANCE: String(performance),
  // The child can find OS tools, but neither a global Node/CLI nor checkout tools.
  PATH:
    process.platform === "win32"
      ? `${process.env.SystemRoot}\\System32`
      : "/usr/bin:/bin",
};
const profile = [
  "--user-data-dir",
  join(root, "portable/user-data"),
  "--extensions-dir",
  join(root, "extensions"),
];
async function run(binary, args, timeout) {
  const program = osOffline ? "/usr/bin/sandbox-exec" : binary;
  const parameters = osOffline
    ? [
        "-p",
        '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
        binary,
        ...args,
      ]
    : args;
  const child = spawn(program, parameters, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
    detached: process.platform !== "win32",
  });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") child.kill("SIGKILL");
    else if (child.pid) process.kill(-child.pid, "SIGKILL");
  };
  const timer = setTimeout(stop, timeout);
  const controller = new AbortController();
  const ui =
    workflow && binary === executable
      ? driveInstalledUI(root, port, controller.signal)
      : Promise.resolve();
  ui.catch(stop);
  try {
    return await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? accept(code)
          : reject(new Error(`Desktop exited ${code}.`)),
      );
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    await ui;
  }
}
await run(
  cli,
  [...profile, "--install-extension", join(root, "tinta.vsix"), "--force"],
  60000,
);
await run(
  executable,
  [
    ...profile,
    "--extensionDevelopmentPath",
    join(root, "harness"),
    ...(!workflow ? ["--extensionTestsPath", join(root, "tests.cjs")] : []),
    "--skip-welcome",
    "--skip-release-notes",
    "--new-window",
    ...(workflow ? [`--remote-debugging-port=${port}`] : []),
    "--disable-updates",
    "--disable-telemetry",
    "--proxy-server=http://127.0.0.1:9",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    ...(!restricted ? ["--disable-workspace-trust"] : []),
    join(root, "workspace"),
  ],
  performance ? 600000 : 120000,
);
const report = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
report.archiveSha256 = inspection.sha256;
report.networkIsolation = osOffline
  ? "OS sandbox denies non-loopback outbound connections for desktop and descendants"
  : "Renderer DNS/proxy denial; exported HTML uses offline browser contexts. No OS-wide offline claim.";
await writeFile(
  join(root, "result.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS" || report.trusted === restricted)
  process.exitCode = 1;
