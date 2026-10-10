import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { captureCandidate } from "./candidate.mjs";

const require = createRequire(
  new URL("../packages/artifacts/package.json", import.meta.url),
);
const { zipSync, unzipSync } = require("fflate");
export const extensionVersion = "0.1.0-dev.0";
export const payloadFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "build-identity.json",
  "language-configuration.json",
  "syntaxes/tinta.tmLanguage.json",
  "dist/extension.mjs",
  "dist/server.mjs",
  "dist/worker.mjs",
  "dist/artifact-worker.mjs",
];
const envelopeFiles = ["[Content_Types].xml", "extension.vsixmanifest"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inspectPackage(bytes) {
  const entries = unzipSync(bytes);
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
      path.endsWith(".mjs") &&
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
    manifest.version !== extensionVersion ||
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
    identity.implementationVersion !== "0.0.0" ||
    !/^[a-f0-9]{64}$/.test(identity.sourceSha256)
  )
    throw new Error("Incomplete or inconsistent build identity.");
  for (const file of identity.payload) {
    if (digest(entries[`extension/${file.path}`]) !== file.sha256)
      throw new Error(`Payload identity mismatch: ${file.path}.`);
  }
  return { sha256: digest(bytes), bytes: bytes.length, files, identity };
}

export async function packageExtension() {
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
    version: extensionVersion,
    description:
      "Local Markdown-first Tinta authoring, preview and export (development build).",
    license: "MIT",
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
              : ["LICENSE", "THIRD_PARTY_NOTICES.txt"].includes(name)
                ? name
                : `apps/vscode/${name}`,
          );
    entries[`extension/${name}`] = bytes;
  }
  const identity = {
    extensionVersion,
    implementationVersion: JSON.parse(
      await readFile("packages/engine/package.json", "utf8"),
    ).version,
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
  entries["[Content_Types].xml"] =
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="mjs" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>`);
  entries["extension.vsixmanifest"] =
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="tinta" Version="${extensionVersion}" Publisher="tinta-local"/>
    <DisplayName>Tinta</DisplayName>
    <Description xml:space="preserve">Local development extension</Description>
    <Tags>markdown</Tags>
    <Categories>Programming Languages</Categories>
    <GalleryFlags>Preview</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.141.0"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
  </Assets>
</PackageManifest>`);
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, bytes]) => [
        path,
        [bytes, { mtime: new Date("2000-01-01T00:00:00Z") }],
      ]),
    ),
    { level: 9 },
  );
  const report = inspectPackage(zipped);
  await mkdir("build/vscode", { recursive: true });
  await writeFile(`build/vscode/tinta-${extensionVersion}.vsix`, zipped);
  await writeFile(
    "build/vscode/archive.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
