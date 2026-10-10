import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { previewHtml } from "../apps/studio/dist/runtime/previewHtml.js";

const executable = process.argv[2];
if (!executable)
  throw new Error("Pass the path to the pinned VS Code executable");
const root = resolve(process.argv[3] ?? "build/vscode-probe");
await mkdir(root);
await build({
  entryPoints: ["tests/vscode/host.mjs"],
  outfile: `${root}/host.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
await build({
  entryPoints: ["tests/vscode/analysis-worker.mjs"],
  outfile: `${root}/analysis.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
});
for (const name of ["outer", "inner-audit"])
  await writeFile(
    `${root}/${name}.js`,
    await readFile(`tests/vscode/${name}.mjs`),
  );
await writeFile(`${root}/preview.html`, previewHtml);
await writeFile(
  `${root}/package.json`,
  JSON.stringify({
    name: "tinta-host-probe",
    version: "0.0.0",
    private: true,
    publisher: "tinta-local",
    engines: { vscode: "1.141.0" },
    main: "./extension.mjs",
    type: "module",
    activationEvents: ["onStartupFinished"],
  }),
);
await writeFile(`${root}/extension.mjs`, "export function activate() {}\n");
await mkdir(`${root}/user/User`, { recursive: true });
await writeFile(
  `${root}/user/User/settings.json`,
  JSON.stringify({
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "workbench.startupEditor": "none",
    "files.autoSave": "off",
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
    root,
    "--extensionTestsPath",
    `${root}/host.cjs`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--new-window",
  ],
  { stdio: "inherit", env: { ...process.env, TINTA_PROBE_ROOT: root } },
);
const timer = setTimeout(() => child.kill(), 60000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(await readFile(`${root}/result.json`, "utf8"));
    if (code !== 0 || result.status !== "PASS")
      throw new Error("Native probe failed");
    console.log(
      `VS Code probe PASS: ${result.sources.length} source cases, worker and webview`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
