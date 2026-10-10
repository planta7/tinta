import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  realpath,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { build } from "esbuild";
import { isDeepStrictEqual } from "node:util";
import { createRequire, builtinModules } from "node:module";
import ts from "typescript";
import { posix } from "node:path";
import { dependencyClosure } from "./release-contract.mjs";
import { requireCommandSync } from "./commands.mjs";
import {
  digest,
  inspectEntries,
  readTarball,
} from "./distribution-archive.mjs";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const encodeJson = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");

export function packageOrder(config) {
  return [
    ...new Set(
      config.packages.flatMap((target) => dependencyClosure(config, target.id)),
    ),
  ].filter((id) => config.packages.some((target) => target.id === id));
}

export function stagingManifest(config, target, source, files) {
  const manifest = {
    name: target.proposedName,
    version: config.versions.implementation,
    private: false,
    type: "module",
    license: "MIT",
    engines: { node: config.policy.nodeRange },
    publishConfig: {
      access: config.policy.npmAccess,
      tag: config.versions.npmChannel,
    },
    exports: structuredClone(source.exports ?? {}),
    dependencies: {
      ...Object.fromEntries(
        target.dependencies.map((id) => [
          config.packages.find((item) => item.id === id).proposedName,
          config.versions.implementation,
        ]),
      ),
      ...target.externalDependencies,
    },
    files: [...files].sort(),
  };
  if (source.bin) manifest.bin = structuredClone(source.bin);
  if (target.id === "reader") manifest.exports["./reader.css"] = "./reader.css";
  if (target.id === "language-server") {
    manifest.exports = { "./ipc": "./dist/server.mjs" };
  } else {
    manifest.types = "./dist/index.d.ts";
  }
  const repository = config.identities.repository.value;
  if (repository) {
    manifest.repository = {
      type: "git",
      url: `https://github.com/${repository}.git`,
      directory: target.source,
    };
  }
  return manifest;
}

export function inspectNpm(
  entries,
  config,
  target,
  expectedManifest,
  expectedFiles,
) {
  const files = inspectEntries(entries, expectedFiles);
  const manifest = JSON.parse(Buffer.from(entries["package.json"]).toString());
  if (
    !isDeepStrictEqual(manifest, expectedManifest) ||
    manifest.private !== false ||
    manifest.name !== target.proposedName ||
    manifest.version !== config.versions.implementation ||
    /(?:workspace|file|link):/.test(JSON.stringify(manifest)) ||
    manifest.scripts
  )
    throw new Error("Invalid publishable manifest.");
  function requireFile(path) {
    if (!path.startsWith("./") || !Object.hasOwn(entries, path.slice(2)))
      throw new Error(`Missing package entry point: ${path}`);
  }
  for (const entry of Object.values(manifest.exports)) {
    if (typeof entry === "string") requireFile(entry);
    else for (const path of Object.values(entry)) requireFile(path);
  }
  for (const path of Object.values(manifest.bin ?? {})) requireFile(path);
  for (const [path, bytes] of Object.entries(entries)) {
    if (
      (!path.startsWith("dist/") &&
        !Object.values(manifest.bin ?? {}).includes("./" + path)) ||
      !/\.(?:js|mjs|ts)$/.test(path)
    )
      continue;
    const imports = ts.preProcessFile(
      Buffer.from(bytes).toString(),
      true,
      true,
    ).importedFiles;
    for (const { fileName } of imports) {
      if (fileName.startsWith(".")) {
        const dependency = posix.normalize(
          posix.join(posix.dirname(path), fileName),
        );
        const resolved = path.endsWith(".d.ts")
          ? dependency.replace(/\.js$/, ".d.ts")
          : dependency;
        if (!Object.hasOwn(entries, resolved))
          throw new Error(`Missing relative dependency: ${path}: ${fileName}`);
      } else if (
        fileName.startsWith("node:") ||
        builtinModules.includes(fileName)
      ) {
        if (!["language-server", "local-files", "cli"].includes(target.id))
          throw new Error(`Node capability in portable package: ${path}`);
      } else {
        const name = fileName.startsWith("@")
          ? fileName.split("/").slice(0, 2).join("/")
          : fileName.split("/")[0];
        if (!Object.hasOwn(manifest.dependencies, name))
          throw new Error(`Undeclared dependency: ${path}: ${name}`);
      }
    }
  }
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
    if (!entries[name]?.length) throw new Error(`Missing license: ${name}`);
  return files;
}

async function declarationFiles(source, entry, entries) {
  const path = entry.replace(/\.js$/, ".d.ts");
  if (entries[`dist/${path}`]) return;
  const bytes = await readFile(`${source}/dist/${path}`);
  entries[`dist/${path}`] = bytes;
  for (const match of bytes
    .toString()
    .matchAll(/(?:from\s*|import\s*\()"(\.\/[^"]+\.js)"/g)) {
    await declarationFiles(source, join(dirname(path), match[1]), entries);
  }
}

async function parserBundle(entries) {
  const result = await build({
    entryPoints: ["packages/syntax/dist/index.js"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    external: ["@tinta/*"],
    write: false,
    metafile: true,
    sourcemap: false,
  });
  const inputs = Object.keys(result.metafile.inputs);
  const tokenizer = inputs.filter((path) =>
    /\/micromark\/lib\/create-tokenizer\.js$/.test(path),
  );
  const parse = inputs.filter((path) =>
    /\/micromark\/lib\/parse\.js$/.test(path),
  );
  if (tokenizer.length !== 1 || parse.length !== 1)
    throw new Error("Expected one patched micromark instance.");
  const tokenizerText = await readFile(tokenizer[0], "utf8");
  if (
    !tokenizerText.includes("observeTokenizer?.('transition', point.offset)") ||
    !tokenizerText.includes(
      "observeTokenizer?.('enter', point.offset, type, stack)",
    ) ||
    !(await readFile(parse[0], "utf8")).includes("settings.observeTokenizer")
  )
    throw new Error("Missing micromark budget patch.");
  const mdast = inputs.find((path) =>
    /\/mdast-util-from-markdown\/lib\/index\.js$/.test(path),
  );
  const directRequire = createRequire(resolve("packages/syntax/package.json"));
  const mdastRequire = createRequire(resolve(mdast));
  if (
    (await realpath(directRequire.resolve("micromark"))) !==
    (await realpath(mdastRequire.resolve("micromark")))
  )
    throw new Error("Direct and mdast parser paths differ.");
  entries["dist/index.js"] = result.outputFiles[0].contents;
  const inventory = await json("toolchain/lock-inventory.json");
  const provenance = [];
  const packages = new Map();
  for (const input of inputs) {
    const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\/(.+)$/.exec(input);
    if (!match) continue;
    const [, root, , file] = match;
    const manifest = await json(`${root}/package.json`);
    const record = inventory.find(
      (item) =>
        item.name === manifest.name && item.version === manifest.version,
    );
    if (!record?.integrity || manifest.private)
      throw new Error(`Unapproved bundled package: ${manifest.name}`);
    const path = `vendor/${manifest.name}/${file}`;
    const bytes = await readFile(input);
    entries[path] = bytes;
    provenance.push({
      path,
      name: manifest.name,
      version: manifest.version,
      sha256: digest(bytes),
    });
    packages.set(root, record);
  }
  for (const [root, record] of packages) {
    const licenses = (await readdir(root)).filter((name) =>
      /^(license|licence|copying|notice)([._-]|$)/i.test(name),
    );
    if (!licenses.length)
      throw new Error(`Missing bundled license: ${record.name}`);
    for (const name of [...licenses, "package.json"])
      entries[`vendor/${record.name}/${name}`] = await readFile(
        `${root}/${name}`,
      );
  }
  entries["patches/micromark.patch"] = await readFile(
    "patches/micromark@4.0.3.patch",
  );
  entries["patches/README.md"] = await readFile("patches/README.md");
  entries["parser-provenance.json"] = encodeJson({
    patchSha256: digest(entries["patches/micromark.patch"]),
    packages: [...packages.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    ),
    sources: provenance.sort((a, b) => a.path.localeCompare(b.path, "en")),
    parserPaths: "direct and mdast resolve the same patched micromark instance",
  });
}

export async function packageNpm(config, destination) {
  const reports = [];
  for (const id of packageOrder(config)) {
    const target = config.packages.find((item) => item.id === id);
    const source = await json(`${target.source}/package.json`);
    const entries = {};
    if (id === "language-server") {
      for (const name of ["server.mjs", "worker.mjs"])
        entries[`dist/${name}`] = await readFile(`apps/vscode/dist/${name}`);
      entries["README.md"] = Buffer.from(
        "# Tinta language server\n\n" +
          "Resolve `@tinta/language-server/ipc` and launch it with Node's `fork` " +
          "and an IPC channel. It speaks LSP over Node IPC, uses UTF-16 positions " +
          "and full document synchronization. The sibling `worker.mjs` must stay " +
          "beside the launcher. No stdio transport or root import is provided.\n",
      );
    } else if (id === "syntax") {
      await parserBundle(entries);
      await declarationFiles(target.source, "index.js", entries);
    } else {
      for (const name of (await readdir(`${target.source}/src`)).sort()) {
        if (
          (!name.endsWith(".ts") && !name.endsWith(".js")) ||
          name.endsWith(".d.ts")
        )
          continue;
        for (const suffix of [".js", ".d.ts"]) {
          const output = name.slice(0, -3) + suffix;
          entries[`dist/${output}`] = await readFile(
            `${target.source}/dist/${output}`,
          );
        }
      }
    }
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
      entries[name] = await readFile(name);
    if (id === "reader")
      entries["reader.css"] = await readFile("build/reader.css");
    if (id === "artifacts")
      entries["dist/runtime-data.js"] = await readFile(
        "packages/artifacts/dist/runtime-data.js",
      );
    if (id === "cli") {
      entries["bin.mjs"] = await readFile("packages/cli/bin.mjs");
      entries["assets/tinta-studio.html"] = await readFile(
        "build/tinta-studio.html",
      );
    }
    const manifest = stagingManifest(
      config,
      target,
      source,
      Object.keys(entries),
    );
    entries["package.json"] = encodeJson(manifest);
    const expected = Object.keys(entries).sort();
    inspectNpm(entries, config, target, manifest, expected);
    const stage = join(config.policy.stagingRoot, id);
    for (const [path, bytes] of Object.entries(entries)) {
      const output = join(stage, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    requireCommandSync([
      "pnpm",
      "--dir",
      resolve(stage),
      "pack",
      "--pack-destination",
      resolve(destination),
    ]);
    const archive = `tinta-${id}-${config.versions.implementation}.tgz`;
    const bytes = await readFile(join(destination, archive));
    const packed = readTarball(bytes);
    const files = inspectNpm(packed, config, target, manifest, expected);
    for (const file of files)
      if (
        file.path !== "package.json" &&
        file.sha256 !== digest(entries[file.path])
      )
        throw new Error(`Packed bytes changed: ${id}/${file.path}`);
    reports.push({ id, archive, files, dependencies: manifest.dependencies });
  }
  return reports;
}
