import {
  implementationVersion,
  studioVersion,
} from "./implementation-version.mjs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { classicBundle } from "./packaging.mjs";

const digest = (text) => createHash("sha256").update(text).digest("base64");
const script = (text) =>
  text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

export async function buildPreview() {
  const preview = await classicBundle(
    "apps/studio/dist/preview.js",
    undefined,
    "browser",
    { minify: true },
  );
  const readerStyle =
    (await readFile("packages/reader/src/reader.css", "utf8")) +
    "\n" +
    (await readFile("apps/studio/src/preview.css", "utf8"));
  const previewCode = script(preview.code);
  const previewPolicy =
    `default-src 'none'; script-src 'sha256-${digest(previewCode)}'; ` +
    `style-src 'sha256-${digest(readerStyle)}'; img-src data: blob:; ` +
    "connect-src 'none'; font-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";
  const previewHtml =
    '<!doctype html><html lang="en"><head><meta charset="UTF-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">` +
    `<style>${readerStyle}</style></head><body>` +
    `<script>${previewCode}</script></body></html>`;
  await writeFile("build/preview.html", previewHtml);
  await writeFile(
    "build/preview-runtime.json",
    JSON.stringify(
      {
        protocol: "tinta-host-1",
        implementationVersion,
        scriptHash: digest(previewCode),
        styleHash: digest(readerStyle),
        htmlSha256: createHash("sha256").update(previewHtml).digest("hex"),
        inputs: preview.inputs,
      },
      null,
      2,
    ) + "\n",
  );
  return { preview, previewHtml, previewCode };
}

export async function buildStudio() {
  const worker = await classicBundle(
    "apps/studio/dist/worker.js",
    undefined,
    "neutral",
    { minify: true },
  );
  const { preview, previewHtml, previewCode } = await buildPreview();

  const examples = {};
  for (const name of ["article", "report", "guide", "chart-atlas"])
    examples[name] = await readFile(`examples/${name}.tinta`, "utf8");
  const assetPaths = JSON.parse(
    await readFile("examples/catalog-assets.json", "utf8"),
  );
  const { compile } = await import("../packages/engine/dist/index.js");
  const { imageDestinations, unwrap } =
    await import("../packages/artifacts/dist/index.js");
  const exampleAssets = {};
  for (const [name, paths] of Object.entries(assetPaths)) {
    if (!Object.hasOwn(examples, name))
      throw new Error(`Unknown catalog example: ${name}`);
    const program = unwrap(
      compile({
        text: examples[name],
        profile: "tinta",
        uri: `tinta:/${name}.tinta`,
      }),
    );
    const destinations = [...new Set(imageDestinations(program.flow))].sort();
    if (JSON.stringify(destinations) !== JSON.stringify([...paths].sort()))
      throw new Error(`Catalog assets do not match ${name}.`);
    exampleAssets[name] = [];
    for (const path of paths) {
      const match = /^assets\/([a-f0-9]{64})\.(png|jpe?g|webp)$/.exec(path);
      if (!match) throw new Error(`Invalid catalog asset path: ${path}`);
      const bytes = await readFile(`examples/${path}`);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (match[1] !== hash)
        throw new Error(`Catalog asset hash does not match: ${path}`);
      exampleAssets[name].push({ path, base64: bytes.toString("base64") });
    }
  }
  const registry = JSON.parse(await readFile("spec/registry.json", "utf8"));
  const templates = {
    meta: '@meta (version: "1.0", title: "Document", locale: "en-US", currency: "USD")',
    let: "@let value = 1",
    calc: "@calc total = 1 + 2",
    slider: '@slider amount = 5 (min: 0, max: 10, step: 1, label: "Amount")',
    toggle: '@toggle visible = false (label: "Show more")',
    choice:
      '@choice option = "First" (options: ["First", "Second"], label: "Option")',
    when: "@when true\nExplanation.\n@end",
    details: '@details "More information"\nExplanation.\n@end',
    data: "@data values\nx:number | y:number\n1 | 2\n2 | 3\n@end",
    view: "@data records\nx:number\n1\n@end\n@view filtered = records (where: row.x > 0)",
    table: '@data records\nx:number\n1\n@end\n@table records (title: "Values")',
    chart:
      "@data points\nx:number | y:number\n1 | 2\n2 | 3\n@end\n" +
      '@chart line points (x: "x", y: "y", title: "Values")',
  };
  const functions = {
    if: "if(true, 1, 0)",
    min: "min(1, 2)",
    max: "max(1, 2)",
    round: "round(1.5)",
    pow: "pow(2, 3)",
    count: "count(values)",
    sum: 'sum(values, "x")',
    mean: 'mean(values, "x")',
    fixed: "fixed(1.5, 2)",
    percent: "percent(0.5)",
    money: "money(10)",
  };
  const icon = await readFile("docs/assets/logo.svg", "utf8");
  const snippets = Object.fromEntries(
    registry.directives.map((name) => ["@" + name, templates[name]]),
  );
  for (const name of registry.functions)
    snippets[name] =
      (["count", "sum", "mean"].includes(name)
        ? "@data values\nx:number\n1\n@end\n\n"
        : "") +
      "{{ " +
      functions[name] +
      " }}";
  const buildFingerprint = createHash("sha256")
    .update(worker.code)
    .update(previewHtml)
    .update(icon)
    .update(
      JSON.stringify({ studioVersion, examples, exampleAssets, snippets }),
    );
  for (const filename of (await readdir("apps/studio/src")).sort()) {
    buildFingerprint.update(filename);
    buildFingerprint.update(await readFile(`apps/studio/src/${filename}`));
  }
  const studioBuild = buildFingerprint.digest("hex").slice(0, 8);
  // Separate generated data modules let Vite split the development build.
  // The standalone IIFE still embeds every runtime in one offline HTML file.
  await mkdir("apps/studio/dist/runtime", { recursive: true });
  for (const [name, value] of Object.entries({
    workerCode: worker.code,
    previewHtml,
  })) {
    await writeFile(
      `apps/studio/dist/runtime/${name}.js`,
      `export const ${name} = ${JSON.stringify(value)};\n`,
    );
  }
  await writeFile(
    "apps/studio/dist/studio-runtime.js",
    'export { workerCode } from "./runtime/workerCode.js";\n' +
      'export { previewHtml } from "./runtime/previewHtml.js";\n' +
      Object.entries({
        examples,
        exampleAssets,
        snippets,
        studioVersion,
        studioBuild,
      })
        .map(
          ([key, value]) => `export const ${key} = ${JSON.stringify(value)};`,
        )
        .join("\n"),
  );
  const studio = await classicBundle("apps/studio/dist/index.js");
  const licenseRoots = new Set();
  for (const input of [...worker.inputs, ...preview.inputs, ...studio.inputs]) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) licenseRoots.add(match[1]);
  }
  const notices = [await readFile("LICENSE", "utf8")];
  for (const root of [...licenseRoots].sort()) {
    const names = (await readdir(root)).filter((name) =>
      /^(license|licence|copying|notice)([._-]|$)/i.test(name),
    );
    if (!names.length)
      throw new Error(`Missing Studio dependency license: ${root}`);
    for (const name of names)
      notices.push(await readFile(`${root}/${name}`, "utf8"));
  }
  studio.code +=
    "\n/*!\n" + notices.join("\n\n").replace(/\*\//g, "* /") + "\n*/\n";
  const code = script(studio.code);
  const style = await readFile("apps/studio/src/studio.css", "utf8");
  const iconUrl = `data:image/svg+xml,${encodeURIComponent(icon)}`;
  const policy =
    `default-src 'none'; script-src 'sha256-${digest(code)}' ` +
    `'sha256-${digest(previewCode)}'; ` +
    "style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:; " +
    "frame-src 'self' blob:; connect-src 'none'; font-src 'none'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'";
  const html =
    '<!doctype html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<link rel="icon" type="image/svg+xml" href="${iconUrl}">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<title>tinta studio</title><style>${style}</style></head><body>` +
    `<script>${code}</script></body></html>`;
  await writeFile("build/tinta-studio.html", html);
  await mkdir("packages/cli/assets", { recursive: true });
  await writeFile("packages/cli/assets/tinta-studio.html", html);
  await writeFile(
    "build/studio-composition.json",
    JSON.stringify(
      {
        workerInputs: worker.inputs,
        previewInputs: preview.inputs,
        studioInputs: studio.inputs,
        bytes: Buffer.byteLength(html),
        hostScriptHash: digest(code),
        previewScriptHash: digest(previewCode),
      },
      null,
      2,
    ) + "\n",
  );
  return { worker, studio, preview };
}
