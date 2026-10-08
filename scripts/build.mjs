import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";
import { classicBundle, inlineScript } from "./packaging.mjs";

await mkdir("build", { recursive: true });

const reader = await classicBundle(
  "packages/reader/src/standalone.ts",
  "TintaReaderRuntime",
);
const worker = await classicBundle("apps/studio/src/worker.ts");
const studio = await classicBundle("apps/studio/src/index.ts");

await writeFile("build/reader.js", reader.code);
await copyFile("packages/reader/src/reader.css", "build/reader.css");
await writeFile("build/worker.js", worker.code);

await writeFile(
  "build/tinta-studio.html",
  `<!doctype html><html lang="en"><meta charset="UTF-8"><title>Tinta foundation</title><p>Foundation scaffold. Document editing is not implemented.</p>${inlineScript(studio.code)}</html>`,
);

await writeFile(
  "build/composition.json",
  JSON.stringify({ reader, worker, studio }, null, 2),
);

await viteBuild({
  root: resolve("apps/studio"),
  configFile: resolve("apps/studio/vite.config.js"),
});
