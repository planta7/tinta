import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const result = await build({
  stdin: {
    contents:
      'export * from "./packages/syntax/dist/index.js"; export * from "./packages/engine/dist/index.js";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
});
const bytes = result.outputFiles[0].contents;
const compressedBytes = gzipSync(bytes).length;
const maximum = 500 * 1024;
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/engine-size.json",
  JSON.stringify(
    {
      bytes: bytes.length,
      gzipBytes: compressedBytes,
      maximumGzipBytes: maximum,
      inputs: Object.keys(result.metafile.inputs),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Portable syntax and engine: ${compressedBytes}/${maximum} gzip bytes.`,
);
if (compressedBytes > maximum) process.exitCode = 1;
