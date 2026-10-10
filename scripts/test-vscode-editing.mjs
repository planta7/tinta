import { build } from "esbuild";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the pinned VS Code desktop executable.");
const root = resolve(process.argv[3]);
await mkdir(root);
await build({
  entryPoints: ["tests/vscode/editing.mjs"],
  outfile: `${root}/tests.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
await copyFile("apps/vscode/dist/worker.mjs", `${root}/worker.mjs`);
await writeFile(
  `${root}/stall.mjs`,
  `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  while (true) {}
});
`,
);
await mkdir(`${root}/user/User`, { recursive: true });
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
    "editor.semanticHighlighting.enabled": true,
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
    resolve("apps/vscode"),
    "--extensionTestsPath",
    `${root}/tests.cjs`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--new-window",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, TINTA_EDITING_TEST_ROOT: root },
  },
);
const timer = setTimeout(() => child.kill(), 60000);
child.on("error", () => {
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(await readFile(`${root}/result.json`, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    if (code !== 0 || result.status !== "PASS") process.exitCode = 1;
  } catch {
    console.error("Native editing tests did not produce a result.");
    process.exitCode = 1;
  }
});
