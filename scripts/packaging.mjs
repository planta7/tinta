import { build } from "esbuild";

// Build infrastructure only: this is not a document exporter or source executor.
export async function classicBundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: false,
    metafile: true,
  });

  if (result.outputFiles.length !== 1)
    throw new Error("Expected one classic script");

  return {
    code: result.outputFiles[0].text,
    inputs: Object.keys(result.metafile.inputs),
  };
}

export function inlineScript(code) {
  return `<script>${code
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--")}</script>`;
}
