import { build } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";

await mkdir("apps/vscode/dist", { recursive: true });
for (const [entry, output, external] of [
  ["apps/vscode/src/extension.ts", "extension", ["vscode"]],
  ["packages/language-server/src/server.ts", "server", []],
  ["packages/language-server/src/worker.ts", "worker", []],
]) {
  await build({
    entryPoints: [entry],
    outfile: `apps/vscode/dist/${output}.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external,
    // The upstream SDK is CommonJS. Only its fixed host bundle gets a Node loader.
    ...(output === "worker"
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
