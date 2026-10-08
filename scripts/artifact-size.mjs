import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
const runtime = JSON.parse(readFileSync("build/export-runtime.json", "utf8"));
const forbidden = runtime.inputs.filter((path) =>
  /packages\/syntax\/|\/compiler\.|react|codemirror/i.test(path),
);
const result = await build({
  stdin: { contents: runtime.code },
  minify: true,
  write: false,
});
const gzipBytes = gzipSync(result.outputFiles[0].contents).length;
const report = {
  gzipBytes,
  maximumGzipBytes: 350 * 1024,
  inputs: runtime.inputs,
  forbidden,
};
writeFileSync(
  "reports/verification/artifact-size.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Standalone runtime: ${gzipBytes}/${report.maximumGzipBytes} gzip bytes; ` +
    `${forbidden.length} forbidden dependencies.`,
);
if (forbidden.length || gzipBytes > report.maximumGzipBytes)
  process.exitCode = 1;
