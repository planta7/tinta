import { buildStudio } from "./studio.mjs";
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

await mkdir("build", { recursive: true });

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
const { worker, studio } = await buildStudio();

await writeFile("build/reader.js", reader.code);
await copyFile("packages/reader/src/reader.css", "build/reader.css");
await writeFile("build/worker.js", worker.code);

for (const name of [
  "types",
  "syntax",
  "engine",
  "charts",
  "reader",
  "artifacts",
  "cli",
]) {
  const target = `packages/${name}/dist/LICENSE`;
  await mkdir(dirname(target), { recursive: true });
  await copyFile("LICENSE", target);
}

await writeFile(
  "build/composition.json",
  JSON.stringify({ reader, worker, studio }, null, 2),
);

await viteBuild({
  root: resolve("apps/studio"),
  configFile: resolve("apps/studio/vite.config.js"),
});
