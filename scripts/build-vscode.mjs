import {
  implementationVersion,
  writeImplementationVersion,
} from "./implementation-version.mjs";
import { build } from "esbuild";
import { classicBundle } from "./packaging.mjs";
import { createHash } from "node:crypto";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";

await mkdir("apps/vscode/dist", { recursive: true });
await writeImplementationVersion();
const previewHtml = await readFile("build/preview.html", "utf8");
const manifest = JSON.parse(
  await readFile("build/preview-runtime.json", "utf8"),
);
if (
  manifest.protocol !== "tinta-host-1" ||
  manifest.implementationVersion !== implementationVersion ||
  manifest.htmlSha256 !== createHash("sha256").update(previewHtml).digest("hex")
)
  throw new Error("Preview build output mismatch. Run pnpm build.");
const outer = await classicBundle(
  "apps/vscode/dist/webview/index.js",
  undefined,
  "browser",
  { minify: true },
);
const outerCode = outer.code
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--");
await writeFile(
  "apps/vscode/dist/preview-runtime.js",
  Object.entries({
    previewHtml,
    outerCode,
    previewScriptHash: manifest.scriptHash,
    previewStyleHash: manifest.styleHash,
  })
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
    .join("\n") + "\n",
);
for (const [entry, output, external] of [
  ["apps/vscode/dist/extension.js", "extension.bundle.js", ["vscode"]],
  ["packages/language-server/src/server.ts", "server.mjs", []],
  ["packages/language-server/src/worker.ts", "worker.mjs", []],
  ["apps/vscode/dist/artifact-worker/index.js", "artifact-worker.mjs", []],
]) {
  await build({
    entryPoints: [entry],
    outfile: `apps/vscode/dist/${output}`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external,
    // The upstream SDK is CommonJS. Only its fixed host bundle gets a Node loader.
    ...(["worker.mjs", "artifact-worker.mjs"].includes(output)
      ? {}
      : {
          banner: {
            js:
              'import { createRequire as tintaCreateRequire } from "node:module";\n' +
              "const require = tintaCreateRequire(import.meta.url);",
          },
        }),
    sourcemap: false,
  });
}
await copyFile("LICENSE", "apps/vscode/dist/LICENSE");
await copyFile(
  "THIRD_PARTY_NOTICES.txt",
  "apps/vscode/dist/THIRD_PARTY_NOTICES.txt",
);
const registry = JSON.parse(await readFile("spec/registry.json", "utf8"));
const server = await readFile("packages/language-server/src/server.ts", "utf8");
for (const [name, field] of [
  ["editorDebounceMs", "debounceMs"],
  ["workerWatchdogMs", "watchdogMs"],
]) {
  if (!server.includes(`${field}: ${registry.limits[name]}`))
    throw new Error(`Host registry drift: ${name}`);
}
console.log("VS Code ESM bundles built with fixed IPC server and worker.");
