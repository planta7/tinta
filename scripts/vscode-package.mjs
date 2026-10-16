import { readZip } from "./distribution-archive.mjs";
import { loadReleaseConfig } from "./release-contract.mjs";
import { implementationVersion } from "./implementation-version.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requireCommandSync } from "./commands.mjs";
import { captureCandidate } from "./candidate.mjs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
export const extensionVersion = "0.1.0-dev.0";
export const payloadFiles = [
  "package.json",
  "README.md",
  "icon.png",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "build-identity.json",
  "language-configuration.json",
  "syntaxes/tinta.tmLanguage.json",
  "dist/extension.bundle.js",
  "dist/server.mjs",
  "dist/worker.mjs",
  "dist/artifact-worker.mjs",
];
const envelopeFiles = ["[Content_Types].xml", "extension.vsixmanifest"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyExtensionChannel(xml, channel) {
  assert.ok(["stable", "pre-release"].includes(channel));
  const properties = [
    ...xml.matchAll(
      /<Property Id="Microsoft\.VisualStudio\.Code\.PreRelease" Value="(true|false)"\s*\/>/g,
    ),
  ];
  assert.ok(properties.length <= 1, "Duplicate extension channel property");
  assert.equal(
    properties[0]?.[1] === "true",
    channel === "pre-release",
    "VSIX channel differs from release plan",
  );
}

export function inspectPackage(
  bytes,
  { release = false, config = loadReleaseConfig() } = {},
) {
  const expectedVersion = release
    ? config.versions.extension
    : extensionVersion;
  const publisher = release
    ? config.identities.marketplacePublisher.value
    : "tinta-local";
  let entries;
  try {
    entries = readZip(bytes);
  } catch (cause) {
    throw new Error("VSIX contains missing or unexpected entries.", { cause });
  }
  const expected = [
    ...envelopeFiles,
    ...payloadFiles.map((name) => `extension/${name}`),
  ].sort();
  const names = Object.keys(entries).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("VSIX contains missing or unexpected entries.");
  const files = names.map((path) => {
    const content = Buffer.from(entries[path]);
    const text = content.toString("utf8");
    if (
      /\/(?:Users|home|root)\/|[A-Z]:[\\/]+Users[\\/]+|\.local\/automation|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sourceMappingURL=|AKIA[0-9A-Z]{16}/.test(
        text,
      )
    )
      throw new Error(`Private or development content in ${path}.`);
    if (
      /\.[cm]?js$/.test(path) &&
      /node_modules\/(?:react|react-dom|@codemirror)\//.test(text)
    )
      throw new Error(`Editor framework in ${path}.`);
    return { path, bytes: content.length, sha256: digest(content) };
  });
  const manifest = JSON.parse(
    Buffer.from(entries["extension/package.json"]).toString(),
  );
  if (
    manifest.name !== "tinta" ||
    manifest.version !== expectedVersion ||
    manifest.publisher !== publisher ||
    manifest.engines?.vscode !== config.policy.vscodeRange ||
    manifest.main !== "./dist/extension.bundle.js" ||
    manifest.type !== "module" ||
    !manifest.private ||
    manifest.dependencies ||
    manifest.devDependencies
  )
    throw new Error("Unexpected installed manifest.");
  const identity = JSON.parse(
    Buffer.from(entries["extension/build-identity.json"]).toString(),
  );
  const identifiedPaths = identity.payload.map((file) => file.path).sort();
  const runtimePaths = payloadFiles
    .filter((path) => path !== "build-identity.json")
    .sort();
  if (
    JSON.stringify(identifiedPaths) !== JSON.stringify(runtimePaths) ||
    identity.extensionVersion !== manifest.version ||
    identity.contractRevision !== "1.0-draft.3" ||
    identity.implementationVersion !== implementationVersion ||
    !/^[a-f0-9]{64}$/.test(identity.sourceSha256)
  )
    throw new Error("Incomplete or inconsistent build identity.");
  for (const file of identity.payload) {
    if (digest(entries[`extension/${file.path}`]) !== file.sha256)
      throw new Error(`Payload identity mismatch: ${file.path}.`);
  }
  const xml = Buffer.from(entries["extension.vsixmanifest"]).toString();
  if (
    !xml.includes(`Version="${expectedVersion}" Publisher="${publisher}"`) ||
    !xml.includes(`Value="${config.policy.vscodeRange}"`)
  )
    throw new Error("Inconsistent VSIX metadata.");
  verifyExtensionChannel(
    xml,
    release ? config.versions.extensionChannel : "stable",
  );
  return {
    sha256: digest(bytes),
    bytes: bytes.length,
    files,
    identity,
    extensionId: `${manifest.publisher}.${manifest.name}`,
  };
}

export async function packageExtension({
  release = false,
  destination = "build/vscode",
  config = loadReleaseConfig(),
} = {}) {
  const version = release ? config.versions.extension : extensionVersion;
  const publisher = release
    ? config.identities.marketplacePublisher.value
    : "tinta-local";
  const candidate = captureCandidate();
  const workspace = JSON.parse(
    await readFile("apps/vscode/package.json", "utf8"),
  );
  const base = { ...workspace };
  delete base.dependencies;
  delete base.devDependencies;
  const manifest = {
    ...base,
    name: "tinta",
    version,
    publisher,
    categories: ["Programming Languages"],
    license: "MIT",
    repository: {
      type: "git",
      url: `https://github.com/${config.identities.repository.value}.git`,
    },
    preview: !release || config.versions.extensionChannel === "pre-release",
  };
  const registry = JSON.parse(await readFile("spec/registry.json", "utf8"));
  const entries = {};
  for (const name of payloadFiles.filter(
    (name) => name !== "build-identity.json",
  )) {
    const bytes =
      name === "package.json"
        ? Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
        : await readFile(
            name === "README.md"
              ? "docs/14_VSCODE_QUICKSTART.md"
              : name === "icon.png"
                ? "apps/vscode/icon.png"
                : name === "LICENSE.txt"
                  ? "LICENSE"
                  : name === "THIRD_PARTY_NOTICES.txt"
                    ? name
                    : `apps/vscode/${name}`,
          );
    entries[`extension/${name}`] = bytes;
  }
  const identity = {
    extensionVersion: version,
    implementationVersion,
    contractRevision: registry.contractRevision,
    sourceVersion: registry.sourceVersion,
    irAbi: "tinta-ir-1",
    hostProtocol: "tinta-host-1",
    outerProtocol: "tinta-vscode-1",
    minimumVSCode: "1.141.0",
    testedVSCode: {
      version: "1.141.0",
      commit: "2a59476c9bfcb90b3ddc372c36762471b7dfad1c",
    },
    commit: candidate.commit,
    dirty: candidate.dirty,
    sourceSha256: candidate.sourceSha256,
    payload: Object.entries(entries).map(([path, bytes]) => ({
      path: path.slice(10),
      sha256: digest(bytes),
    })),
  };
  entries["extension/build-identity.json"] = Buffer.from(
    JSON.stringify(identity, null, 2) + "\n",
  );
  const staging = await mkdtemp(join(tmpdir(), "tinta-vsix-"));
  let zipped;
  try {
    for (const [path, bytes] of Object.entries(entries)) {
      const output = join(staging, "extension", path.slice(10));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    const output = join(staging, "extension.vsix");
    requireCommandSync(
      [
        "node",
        require.resolve("@vscode/vsce/vsce"),
        "package",
        "--no-dependencies",
        "--no-rewrite-relative-links",
        "--out",
        output,
        ...(release && config.versions.extensionChannel === "pre-release"
          ? ["--pre-release"]
          : []),
      ],
      { cwd: join(staging, "extension") },
    );
    zipped = await readFile(output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const report = inspectPackage(zipped, { release, config });
  await mkdir(destination, { recursive: true });
  await writeFile(`${destination}/tinta-${version}.vsix`, zipped);
  await writeFile(
    `${destination}/archive.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
