import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { requireCommandSync } from "./commands.mjs";
import { digest } from "./distribution-archive.mjs";

const globalModules = process.env.TINTA_GLOBAL_MODULES;
assert.ok(globalModules, "Global module directory required");
const pnpm = join(globalModules, "pnpm/bin/pnpm.cjs");
const npm = join(globalModules, "npm/bin/npm-cli.js");
assert.ok(
  existsSync(pnpm) && existsSync(npm),
  "Pinned global package managers missing",
);
const values = {
  TINTA_CONSUMER_PNPM: pnpm,
  TINTA_NPM_CLI: npm,
  npm_execpath: pnpm,
};
if (process.argv.includes("--desktop")) {
  const cell = `${process.platform}-${process.arch}`;
  const key = cell === "win32-x64" ? "win32-x64-archive" : cell;
  const pin = JSON.parse(readFileSync("toolchain/vscode-downloads.json"))[key];
  assert.ok(pin && pin.productVersion === "1.141.0");
  assert.equal(pin.version, "2a59476c9bfcb90b3ddc372c36762471b7dfad1c");
  assert.ok(pin.url.startsWith("https://vscode.download.prss.microsoft.com/"));
  const root = join(process.env.RUNNER_TEMP, "tinta-desktop");
  mkdirSync(root);
  const archive = join(
    root,
    cell === "linux-arm64" ? "desktop.tar.gz" : "desktop.zip",
  );
  const response = await fetch(pin.url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  assert.ok(response.ok, "Desktop download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), pin.sha256hash, "Desktop archive hash mismatch");
  writeFileSync(archive, bytes);
  if (process.platform === "darwin")
    requireCommandSync(["ditto", "-x", "-k", archive, root]);
  else if (process.platform === "linux")
    requireCommandSync(["tar", "-xzf", archive, "-C", root]);
  else requireCommandSync(["tar", "-xf", archive, "-C", root]);
  const app =
    process.platform === "darwin"
      ? join(root, "Visual Studio Code.app/Contents/Resources/app")
      : process.platform === "linux"
        ? join(root, "VSCode-linux-arm64/resources/app")
        : join(root, "resources/app");
  values.TINTA_VSCODE_EXECUTABLE =
    process.platform === "darwin"
      ? join(root, "Visual Studio Code.app/Contents/MacOS/Electron")
      : process.platform === "linux"
        ? join(root, "VSCode-linux-arm64/code")
        : join(root, "Code.exe");
  values.TINTA_VSCODE_CLI =
    process.platform === "win32"
      ? join(app, "out/cli.js")
      : join(app, "bin/code");
  if (process.platform === "linux")
    values.TINTA_VSCODE_CLI = join(root, "VSCode-linux-arm64/bin/code");
  values.TINTA_VSCODE_PRODUCT = join(app, "product.json");
  values.TINTA_VSCODE_PACKAGE = join(app, "package.json");
}
for (const [name, value] of Object.entries(values)) {
  assert.ok(!/[\r\n]/.test(value));
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}
