import { build } from "esbuild";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const executable = process.argv[2];
if (!executable || !process.argv[3])
  throw new Error("Pass a desktop executable and a fresh temporary directory.");
const root = resolve(process.argv[3]);
const restricted = process.argv.includes("--restricted");
await mkdir(root);
await build({
  entryPoints: ["tests/vscode/files-integration.mjs"],
  outfile: `${root}/tests.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  define: {
    "import.meta.url": JSON.stringify(pathToFileURL(`${root}/tests.cjs`).href),
  },
  plugins: [
    {
      name: "scripted-native-dialog-selections",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, (args) =>
          /vscode\/dist\/files\.js$/.test(args.importer)
            ? { path: resolve("tests/vscode/file-dialogs.mjs") }
            : undefined,
        );
      },
    },
  ],
});
await copyFile(
  "apps/vscode/dist/artifact-worker.mjs",
  `${root}/artifact-worker.mjs`,
);
await copyFile(
  "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
  `${root}/photo ñ.png`,
);
await mkdir(`${root}/extension`);
await writeFile(
  `${root}/extension/package.json`,
  JSON.stringify({
    name: "file-workflow-tests",
    version: "0.0.0",
    publisher: "tinta-local",
    engines: { vscode: "^1.141.0" },
    main: "./extension.cjs",
    activationEvents: ["*"],
    capabilities: { untrustedWorkspaces: { supported: true } },
    contributes: { languages: [{ id: "tinta", extensions: [".tinta"] }] },
  }),
);
await writeFile(
  `${root}/extension/extension.cjs`,
  "exports.activate = () => {};\n",
);
await mkdir(`${root}/user/User`, { recursive: true });
await mkdir(`${root}/workspace`);
await writeFile(
  `${root}/user/User/settings.json`,
  JSON.stringify({
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "workbench.startupEditor": "none",
    "chat.disableAIFeatures": true,
    "files.autoSave": "off",
    "security.workspace.trust.startupPrompt": "never",
    "security.workspace.trust.emptyWindow": !restricted,
  }),
);
const child = spawn(
  executable,
  [
    "--user-data-dir",
    `${root}/user`,
    "--extensions-dir",
    `${root}/extensions`,
    "--extensionDevelopmentPath",
    `${root}/extension`,
    "--extensionTestsPath",
    `${root}/tests.cjs`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    ...(!restricted ? ["--disable-workspace-trust"] : []),
    "--new-window",
    `${root}/workspace`,
  ],
  { stdio: "inherit", env: { ...process.env, TINTA_FILES_TEST_ROOT: root } },
);
const timer = setTimeout(() => child.kill(), 120000);
child.on("error", () => {
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(await readFile(`${root}/result.json`, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    if (code !== 0 || result.status !== "PASS" || result.trusted === restricted)
      process.exitCode = 1;
  } catch {
    console.error("Native file tests did not produce a result.");
    process.exitCode = 1;
  }
});
