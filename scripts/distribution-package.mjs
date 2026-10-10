import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  cp,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireCommandSync } from "./commands.mjs";
import { captureCandidate } from "./candidate.mjs";
import { join, relative, dirname, resolve } from "node:path";
import { compile, createSession } from "../packages/engine/dist/index.js";
import {
  createAsset,
  exportHtml,
  packSource,
  unwrap,
} from "../packages/artifacts/dist/index.js";

const candidate = captureCandidate();
const destination = "build/distribution";
await mkdir(destination, { recursive: true });
const files = [];
async function save(name, bytes) {
  await writeFile(join(destination, name), bytes);
  files.push({
    path: name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt", "pnpm-lock.yaml"]) {
  await save(name, await readFile(name));
}
for (const name of ["tinta-studio.html", "reader.js", "reader.css"]) {
  await save(name, await readFile(join("build", name)));
}
await rm(join(destination, "studio"), { recursive: true, force: true });
await cp("build/studio", join(destination, "studio"), { recursive: true });
await inventory(join(destination, "studio"));
const assets = new Map();
for (const name of await readdir("examples/assets")) {
  const asset = unwrap(
    createAsset(await readFile(join("examples/assets", name))),
  );
  assets.set(asset.path, asset);
}
for (const name of (await readdir("examples"))
  .filter((name) => name.endsWith(".tinta"))
  .sort()) {
  const bytes = await readFile(join("examples", name));
  const program = unwrap(
    compile({ bytes, profile: "tinta", uri: `tinta:${name}` }),
  );
  const session = unwrap(createSession(program));
  try {
    await save(name, bytes);
    await save(`${name}.zip`, unwrap(await packSource(program, assets)).bytes);
    for (const format of ["interactive", "static"]) {
      const result = unwrap(
        await exportHtml(session, assets, { format, answers: "initial" }),
      );
      await save(`${name}.${format}.html`, result.bytes);
    }
  } finally {
    session.destroy();
  }
}
// Rebuild only the generated source copy, using the reviewed Git candidate inventory.
await rm(join(destination, "source"), { recursive: true, force: true });
for (const file of candidate.files) {
  const target = join(destination, "source", file.path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file.path, target);
}
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else {
      const bytes = await readFile(path);
      files.push({
        path: relative(destination, path),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
const distributions = resolve(destination, "packages");
await mkdir(distributions, { recursive: true });
for (const name of [
  "types",
  "syntax",
  "engine",
  "charts",
  "reader",
  "artifacts",
  "cli",
]) {
  requireCommandSync([
    "pnpm",
    "--dir",
    `packages/${name}`,
    "pack",
    "--pack-destination",
    distributions,
  ]);
}
await inventory(distributions);
await inventory(join(destination, "source"));
await writeFile(
  join(destination, "manifest.json"),
  JSON.stringify(
    {
      buildKind: "development",
      baseRevision: candidate.commit,
      sourceRevision: candidate.dirty ? "UNCOMMITTED" : candidate.commit,
      engineRevision: candidate.dirty ? "UNCOMMITTED" : candidate.commit,
      sourceSha256: candidate.sourceSha256,
      files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
      limitations: [
        "Development build; source-format version does not establish a stable tool release.",
        "Browser and filesystem behavior depend on the documented environment requirements.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Local distribution package: ${files.length} hashed files in ${destination}`,
);
