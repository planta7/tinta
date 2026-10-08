import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const result = await build({
  entryPoints: ["packages/reader/src/standalone.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "TintaReaderRuntime",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
});
const bytes = result.outputFiles[0].contents;
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((path) =>
  /(?:packages\/(?:syntax)\/|node_modules\/.*(?:react|codemirror)|compiler|program-validator|packages\/engine\/(?:src|dist)\/(?!chart-presentation\.(?:ts|js)|index\.(?:ts|js)))/i.test(
    path,
  ),
);
const gzipBytes = gzipSync(bytes).length;
const maximumGzipBytes = 350 * 1024;
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/reader-size.json",
  JSON.stringify(
    {
      bytes: bytes.length,
      gzipBytes,
      maximumGzipBytes,
      inputs,
      forbidden,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Document reader: ${gzipBytes}/${maximumGzipBytes} gzip bytes; ${forbidden.length} forbidden dependencies.`,
);
if (gzipBytes > maximumGzipBytes || forbidden.length) process.exitCode = 1;
