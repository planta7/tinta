import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { requireCommandSync } from "./commands.mjs";
import { captureCandidate } from "./candidate.mjs";
import {
  loadReleaseConfig,
  selectedTargets,
  targetVersion,
  dependencyClosure,
} from "./release-contract.mjs";
import { packageNpm } from "./distribution-npm.mjs";
import { packageExtension } from "./vscode-package.mjs";
import {
  digest,
  inspectEntries,
  zipEntries,
  readZip,
  readTarball,
} from "./distribution-archive.mjs";

const config = loadReleaseConfig();
const candidate = captureCandidate();
const component = process.env.TINTA_COMPONENT;
const selected = selectedTargets(config);
const includes = (id) => selected.some((target) => target.id === id);
const sourcePaths = JSON.parse(
  await readFile("toolchain/distribution-source.json", "utf8"),
);
if (
  JSON.stringify(sourcePaths) !==
  JSON.stringify(candidate.files.map((file) => file.path))
)
  throw new Error(
    "Source inventory differs from the explicit public file allowlist.",
  );
const destination = "build/distribution";
// CI packages the outputs already exercised by the source suites.
if (!process.argv.includes("--built")) {
  for (const path of [
    "build",
    ...config.packages.map((item) => `${item.source}/dist`),
    "apps/studio/dist",
    "apps/vscode/dist",
  ])
    await rm(path, { recursive: true, force: true });
  requireCommandSync(["pnpm", component ? `build:${component}` : "build"]);
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const reports = await packageNpm(config, destination);

let releasePlan;
if (process.env.TINTA_RELEASE_SOURCE_SHA) {
  const bytes = await readFile("reports/release/plan.json");
  await writeFile(join(destination, "release-plan.json"), bytes);
  releasePlan = { path: "release-plan.json", sha256: digest(bytes) };
}
const licenses = {};
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
  licenses[name] = await readFile(name);

async function archive(id, entries, options) {
  const expected = Object.keys(entries).sort();
  const files = inspectEntries(entries, expected, options);
  const bytes = zipEntries(entries);
  const decoded = readZip(bytes);
  inspectEntries(decoded, expected, options);
  for (const file of files)
    if (digest(decoded[file.path]) !== file.sha256)
      throw new Error(`ZIP content mismatch: ${id}/${file.path}`);
  const name = `${id}-${targetVersion(config, id)}.zip`;
  await writeFile(join(destination, name), bytes);
  reports.push({ id, archive: name, files });
}

async function tree(directory, prefix = "") {
  const entries = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  )) {
    const path = join(directory, item.name);
    const name = prefix + item.name;
    if (item.isSymbolicLink())
      throw new Error("Distribution symlinks are forbidden.");
    if (item.isDirectory())
      Object.assign(entries, await tree(path, name + "/"));
    else entries[name] = await readFile(path);
  }
  return entries;
}

if (includes("studio-directory")) {
  const studio = await tree("build/studio");
  if (
    !studio["index.html"] ||
    Object.keys(studio).some(
      (name) =>
        !["index.html", "LICENSE", "THIRD_PARTY_NOTICES.txt"].includes(name) &&
        !/^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(name),
    )
  )
    throw new Error("Unexpected Studio output inventory.");
  await archive("studio-directory", { ...studio, ...licenses });
  await archive("studio-standalone", {
    "tinta-studio.html": await readFile("build/tinta-studio.html"),
    ...licenses,
  });
}
if (includes("reader-runtime"))
  await archive("reader-runtime", {
    "reader.js": await readFile("build/reader.js"),
    "reader.css": await readFile("build/reader.css"),
    ...licenses,
  });

const source = {};
for (const file of candidate.files) {
  if (!(await lstat(file.path)).isFile())
    throw new Error("Source must be a regular file.");
  const bytes = await readFile(file.path);
  if (digest(bytes) !== file.sha256)
    throw new Error("Source changed during packaging.");
  source[file.path] = bytes;
}
await archive("source", source, { source: true });

if (includes("examples")) {
  const { compile, createSession } =
    await import("../packages/engine/dist/index.js");
  const { createAsset, exportHtml, packSource, unwrap } =
    await import("../packages/artifacts/dist/index.js");
  const examples = { ...licenses };
  const assets = new Map();
  for (const path of sourcePaths.filter((path) =>
    path.startsWith("examples/assets/"),
  )) {
    const bytes = await readFile(path);
    const asset = unwrap(createAsset(bytes));
    assets.set(asset.path, asset);
    examples[path.slice(9)] = bytes;
  }
  for (const path of sourcePaths.filter((path) =>
    /^examples\/[^/]+\.tinta$/.test(path),
  )) {
    const bytes = await readFile(path);
    const name = path.slice(9);
    const program = unwrap(
      compile({ bytes, profile: "tinta", uri: `tinta:${name}` }),
    );
    const session = unwrap(createSession(program));
    try {
      examples[name] = bytes;
      examples[`${name}.zip`] = unwrap(await packSource(program, assets)).bytes;
      for (const format of ["interactive", "static"])
        examples[`${name}.${format}.html`] = unwrap(
          await exportHtml(session, assets, { format, answers: "initial" }),
        ).bytes;
    } finally {
      session.destroy();
    }
  }
  await archive("examples", examples);
}
if (includes("vscode")) {
  const extension = await packageExtension({ release: true, destination });
  reports.push({
    id: "vscode",
    archive: `tinta-${config.versions.extension}.vsix`,
    files: extension.files,
  });
  await rm(join(destination, "archive.json"));
}

// Preserve the complete frozen external graph, including optional and peer edges.
const lock = parseYaml(await readFile("pnpm-lock.yaml", "utf8"));
const records = JSON.parse(
  await readFile("toolchain/lock-inventory.json", "utf8"),
);
const closure = new Map();
function dependency(name, version) {
  const key = `${name}@${version}`;
  if (closure.has(key)) return;
  const snapshot = lock.snapshots[key];
  const base = `${name}@${version.split("(")[0]}`;
  const record = records.find(
    (item) => `${item.name}@${item.version}` === base,
  );
  if (
    !snapshot ||
    !record ||
    !lock.packages[base]?.resolution.integrity ||
    name.startsWith("@tinta-lang/")
  )
    throw new Error(`Unapproved external dependency: ${key}`);
  closure.set(key, {
    key,
    ...record,
    dependencies: snapshot.dependencies ?? {},
    optionalDependencies: snapshot.optionalDependencies ?? {},
  });
  for (const [child, resolved] of Object.entries({
    ...snapshot.dependencies,
    ...snapshot.optionalDependencies,
  }))
    dependency(child, resolved);
}
const dependencyIds = new Set(
  selected.flatMap((target) => dependencyClosure(config, target.id)),
);
for (const target of [...config.packages, ...config.artifacts].filter(
  (target) => dependencyIds.has(target.id),
)) {
  for (const [name, version] of Object.entries(target.externalDependencies)) {
    const resolved = lock.importers[target.source]?.dependencies?.[name];
    if (resolved?.specifier !== version)
      throw new Error("External lock pin mismatch.");
    dependency(name, resolved.version);
  }
}
const verificationPackages = [];
if (component === "studio") {
  const plan = process.env.TINTA_RELEASE_SOURCE_SHA
    ? JSON.parse(await readFile("reports/release/plan.json", "utf8"))
    : undefined;
  const supplied = plan?.components.language.publish
    ? JSON.parse(
        await readFile("build/payloads/language/inventory.json", "utf8"),
      )
    : undefined;
  if (supplied && supplied.source.commit !== candidate.commit)
    throw new Error("Language dependency source mismatch.");
  await mkdir(join(destination, "verification"), { recursive: true });
  for (const target of config.packages.filter(
    (target) => dependencyIds.has(target.id) && !includes(target.id),
  )) {
    let archive;
    let bytes;
    const record = supplied?.targets.find((item) => item.id === target.id);
    if (supplied) {
      if (!record) throw new Error(`Missing language dependency: ${target.id}`);
      archive = `verification/${record.archive}`;
      bytes = await readFile(join("build/payloads/language", record.archive));
      if (digest(bytes) !== record.sha256)
        throw new Error("Changed language dependency.");
      await writeFile(join(destination, archive), bytes);
    } else {
      const packed = JSON.parse(
        requireCommandSync([
          "npm",
          "pack",
          `${target.proposedName}@${config.versions.implementation}`,
          "--registry=https://registry.npmjs.org",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          join(destination, "verification"),
        ]).stdout,
      );
      if (packed.length !== 1) throw new Error("Ambiguous dependency archive.");
      archive = `verification/${packed[0].filename}`;
      bytes = await readFile(join(destination, archive));
      const integrity =
        "sha512-" + createHash("sha512").update(bytes).digest("base64");
      if (integrity !== packed[0].integrity)
        throw new Error("Dependency integrity mismatch.");
    }
    const entries = readTarball(bytes);
    const manifest = JSON.parse(entries["package.json"]);
    if (
      manifest.name !== target.proposedName ||
      manifest.version !== config.versions.implementation ||
      manifest.private !== false ||
      manifest.scripts
    )
      throw new Error("Invalid installed dependency identity.");
    verificationPackages.push({
      id: target.id,
      archive,
      files: inspectEntries(entries, Object.keys(entries)),
    });
  }
}
for (const report of [...reports, ...verificationPackages]) {
  const bytes = await readFile(join(destination, report.archive));
  Object.assign(report, {
    bytes: bytes.length,
    sha256: digest(bytes),
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  });
}
await writeFile(
  join(destination, "inventory.json"),
  JSON.stringify(
    {
      buildKind: "local-distribution",
      source: {
        commit: candidate.commit,
        dirty: candidate.dirty,
        sha256: candidate.sourceSha256,
      },
      versions: config.versions,
      ...(component ? { component, verificationPackages } : {}),
      ...(releasePlan ? { releasePlan } : {}),
      toolchain: {
        node: process.versions.node,
        pnpm: JSON.parse(await readFile("package.json", "utf8")).packageManager,
        platform: process.platform,
        architecture: process.arch,
      },
      lockSha256: digest(await readFile("pnpm-lock.yaml")),
      configSha256: digest(await readFile("toolchain/release.json")),
      externalDependencies: [...closure.values()].sort((a, b) =>
        a.key.localeCompare(b.key, "en"),
      ),
      targets: reports,
      limitations: [
        "Local artifact inventory, not an attested or installed-consumer verification manifest.",
        "Configured identities and repository metadata do not establish registry authentication or published availability.",
        "Native Linux/Windows and system-wide offline verification remain outstanding.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Packed ${reports.length} local distribution targets in ${destination}.`,
);
