import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  previewHtml,
  previewScriptHash,
  previewStyleHash,
} from "../apps/vscode/dist/preview-runtime.js";

const executable = process.argv[2];
if (!executable || !process.argv[3])
  throw new Error("Pass a desktop executable and a fresh temporary directory.");
const root = resolve(process.argv[3]);
await mkdir(root);
const digest = (code) => createHash("sha256").update(code).digest("base64");
const audit = await readFile("tests/vscode/preview-inner.mjs", "utf8");
const instrumented = previewHtml
  .replace(
    `script-src 'sha256-${previewScriptHash}'`,
    `script-src 'sha256-${previewScriptHash}' 'sha256-${digest(audit)}'`,
  )
  .replace("</body>", `<script>${audit}</script></body>`);
const bridge = await build({
  entryPoints: ["apps/vscode/dist/webview/index.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  plugins: [
    {
      name: "isolated-test-observer",
      setup(builder) {
        builder.onLoad({ filter: /webview\/index\.js$/ }, async (args) => ({
          contents: (await readFile(args.path, "utf8")).replace(
            "const api = acquireVsCodeApi();",
            `const api = acquireVsCodeApi();
        window.addEventListener("message", (event) => {
          if (event.data?.kind === "preview-test") {
            event.stopImmediatePropagation();
            frame.contentWindow.postMessage(event.data, "*");
          } else if (event.source === frame.contentWindow && event.data?.kind === "preview-test-result") {
            api.postMessage(event.data);
          }
        });`,
          ),
          loader: "js",
        }));
      },
    },
  ],
});
const outerCode = bridge.outputFiles[0].text
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--");
const runtime = Object.entries({
  previewHtml: instrumented,
  outerCode,
  previewScriptHash: `${previewScriptHash}' 'sha256-${digest(audit)}`,
  previewStyleHash,
})
  .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
  .join("\n");
await build({
  entryPoints: ["tests/vscode/preview-native.mjs"],
  outfile: `${root}/tests.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  plugins: [
    {
      name: "isolated-preview-runtime",
      setup(builder) {
        builder.onLoad(
          { filter: /vscode\/dist\/preview-runtime\.js$/ },
          () => ({ contents: runtime, loader: "js" }),
        );
      },
    },
  ],
});
await mkdir(`${root}/extension`);
await writeFile(
  `${root}/extension/package.json`,
  JSON.stringify({
    name: "preview-tests",
    version: "0.0.0",
    publisher: "tinta-local",
    engines: { vscode: "^1.141.0" },
    main: "./extension.cjs",
    activationEvents: ["*"],
    contributes: { languages: [{ id: "tinta", extensions: [".tinta"] }] },
  }),
);
await writeFile(
  `${root}/extension/extension.cjs`,
  "exports.activate = () => {};\n",
);
await copyFile("examples/chart-atlas.tinta", `${root}/atlas.tinta`);
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
    "workbench.colorTheme": "Default Dark Modern",
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
    "--disable-workspace-trust",
    "--new-window",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TINTA_PREVIEW_TEST_ROOT: root,
      TINTA_PREVIEW_KEYBOARD: String(process.argv[4] === "--keyboard"),
    },
  },
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
    if (code !== 0 || result.status !== "PASS") process.exitCode = 1;
  } catch {
    console.error("Native preview tests did not produce a result.");
    process.exitCode = 1;
  }
});
