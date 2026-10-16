import {
  writeImplementationVersion,
  writeCliVersion,
} from "./implementation-version.mjs";
import { buildStudio, buildPreview } from "./studio.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  writeFile,
  copyFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { build as viteBuild } from "vite";
import { classicBundle } from "./packaging.mjs";

const component = process.argv[2];
assert.ok(
  component === undefined ||
    ["language", "studio", "vscode"].includes(component),
);

await mkdir("build", { recursive: true });
await writeImplementationVersion();

const reader = await classicBundle(
  "packages/reader/src/standalone.ts",
  "TintaReaderRuntime",
);
const exportRuntime = await classicBundle(
  "packages/reader/src/export-runtime.ts",
  "TintaExportRuntime",
  "browser",
  { minify: true },
);
const licenseRoots = new Set();
for (const input of exportRuntime.inputs) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) licenseRoots.add(match[1]);
}
const notices = [await readFile("LICENSE", "utf8")];
for (const root of [...licenseRoots].sort()) {
  const names = (await readdir(root)).filter((name) =>
    /^(license|licence|copying|notice)([._-]|$)/i.test(name),
  );
  if (!names.length) throw new Error(`Missing runtime license: ${root}`);
  for (const name of names)
    notices.push(await readFile(join(root, name), "utf8"));
}
exportRuntime.code +=
  "\n/*!\n" + notices.join("\n\n").replace(/\*\//g, "* /") + "\n*/\n";
await writeFile(
  "packages/artifacts/dist/runtime-data.js",
  `export const readerCode = ${JSON.stringify(exportRuntime.code)};\n` +
    `export const readerStyle = ${JSON.stringify(
      await readFile("packages/reader/src/reader.css", "utf8"),
    )};\n`,
);
await writeFile(
  "build/export-runtime.json",
  JSON.stringify(exportRuntime, null, 2),
);

await writeFile("build/reader.js", reader.code);
await copyFile("packages/reader/src/reader.css", "build/reader.css");

for (const name of [
  "types",
  "syntax",
  "engine",
  "language-service",
  "local-files",
  "charts",
  "reader",
  "artifacts",
  "cli",
]) {
  const target = `packages/${name}/dist/LICENSE`;
  if (existsSync(dirname(target))) await copyFile("LICENSE", target);
}

if (component === undefined || component === "studio") {
  const { worker, studio } = await buildStudio();
  await writeCliVersion();
  await writeFile("build/worker.js", worker.code);
  await writeFile(
    "build/composition.json",
    JSON.stringify({ reader, worker, studio }, null, 2),
  );
  await viteBuild({
    root: resolve("apps/studio"),
    configFile: resolve("apps/studio/vite.config.js"),
  });
  await copyFile(
    "THIRD_PARTY_NOTICES.txt",
    "build/studio/THIRD_PARTY_NOTICES.txt",
  );
  await copyFile("LICENSE", "build/studio/LICENSE");
}
if (component === "vscode") await buildPreview();
if (component === undefined || component === "vscode")
  await import("./build-vscode.mjs");
