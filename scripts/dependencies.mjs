import { readFileSync } from "node:fs";
import { parse } from "yaml";
import semver from "semver";
import { workspaceOwners, ownerPath } from "./architecture.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const root = read("package.json"),
  records = read("toolchain/dependencies.json");

if (process.versions.node !== root.engines.node)
  throw new Error("Wrong Node baseline");

const lock = parse(readFileSync("pnpm-lock.yaml", "utf8"));

for (const [name, entry] of Object.entries(lock.packages))
  if (!entry.resolution?.integrity)
    throw new Error(`Missing integrity: ${name}`);

for (const path of [
  "package.json",
  ...workspaceOwners().map((owner) => `${ownerPath(owner)}/package.json`),
]) {
  const manifest = read(path);
  if (!manifest.private) throw new Error(`Publication enabled: ${path}`);
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (name.startsWith("@tinta-lang/")) continue;
    if (!semver.valid(version)) throw new Error(`Not exact: ${name}`);
    const record = records.find(
      (r) => r.name === name && r.version === version,
    );
    if (!record?.dist.integrity || !record.license)
      throw new Error(`Missing provenance: ${name}`);
    if (
      record.engines?.node &&
      !semver.satisfies(root.engines.node, record.engines.node)
    )
      throw new Error(`Engine mismatch: ${name}`);
  }
}

console.log(
  `Dependency pins PASS: ${records.length} resolved direct tools/helpers, ${Object.keys(lock.packages).length} integrity records; install enforces peers`,
);

const browsers = read(
  "node_modules/.pnpm/playwright-core@" +
    root.devDependencies["@playwright/test"] +
    "/node_modules/playwright-core/browsers.json",
);

if (
  JSON.stringify(browsers) !== JSON.stringify(read("toolchain/browsers.json"))
)
  throw new Error("Browser revisions differ from reviewed pins");
