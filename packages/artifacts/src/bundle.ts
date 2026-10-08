import type {
  Artifact,
  Asset,
  AssetStore,
  OpenedBundle,
  Program,
  Result,
} from "@tinta/types";
import { compile, createSession } from "@tinta/engine";
import {
  artifact,
  attempt,
  canonicalJson,
  decodeUtf8,
  encodeUtf8,
  hash,
  object,
  reject,
  strictJson,
  unwrap,
} from "./common.js";
import { canonicalSource } from "./source.js";
import { createAsset, requiredAssets, validateAssets } from "./assets.js";
import { readZip, writeZip } from "./zip.js";

export async function packSource(
  program: Program,
  assets: AssetStore,
): Promise<Result<Artifact>> {
  return attempt(() => {
    if (program.profile !== "tinta")
      reject("E_EXPORT_INVALID", "Source bundles require the Tinta profile.");

    const copy = canonicalSource(program, assets);
    const source = encodeUtf8(copy.program.source);
    const sorted = [...copy.assets.values()].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    );
    const manifest = {
      kind: "tinta-source-bundle",
      formatVersion: "1.0",
      source: {
        path: "document.tinta",
        bytes: source.length,
        sha256: hash(source),
      },
      assets: sorted.map(({ path, mime, bytes, sha256 }) => ({
        path,
        mime,
        bytes: bytes.length,
        sha256,
      })),
    };

    return artifact(
      writeZip(
        new Map([
          ["manifest.json", encodeUtf8(canonicalJson(manifest))],
          ["document.tinta", source],
          ...sorted.map((asset) => [asset.path, asset.bytes] as const),
        ]),
      ),
      "application/zip",
      "document.tinta.zip",
    );
  });
}

export async function openBundle(
  bytes: Uint8Array,
): Promise<Result<OpenedBundle>> {
  return attempt(() => {
    const entries = readZip(bytes);
    let manifestText: string;
    try {
      manifestText = decodeUtf8(entries.get("manifest.json")!);
    } catch {
      reject("E_ENCODING", "Bundle metadata is not valid UTF-8.");
    }

    const manifest = object(strictJson(manifestText, 65536), [
      "kind",
      "formatVersion",
      "source",
      "assets",
    ]);
    if (
      manifest.kind !== "tinta-source-bundle" ||
      manifest.formatVersion !== "1.0" ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length > 100
    )
      reject("E_BUNDLE", "Invalid bundle manifest.");

    const source = object(manifest.source, ["path", "bytes", "sha256"]);
    const sourceBytes = entries.get("document.tinta")!;
    if (
      source.path !== "document.tinta" ||
      source.bytes !== sourceBytes.length ||
      source.sha256 !== hash(sourceBytes)
    )
      reject("E_HASH_MISMATCH", "Bundle source hash or length mismatch.");
    if (entries.size !== manifest.assets.length + 2)
      reject("E_BUNDLE", "Bundle entries do not match the manifest.");

    const assets = new Map<string, Asset>();

    for (const entry of manifest.assets) {
      const item = object(entry, ["path", "mime", "bytes", "sha256"]);
      if (
        typeof item.path !== "string" ||
        !item.path.startsWith("assets/") ||
        assets.has(item.path)
      )
        reject("E_BUNDLE", "Duplicate or invalid manifest asset.");
      const data = entries.get(item.path);
      if (!data || data.length !== item.bytes)
        reject("E_BUNDLE", "Missing asset or mismatched byte length.");
      const asset = unwrap(createAsset(data));
      if (
        asset.path !== item.path ||
        asset.sha256 !== item.sha256 ||
        asset.mime !== item.mime
      )
        reject("E_HASH_MISMATCH", "Manifest asset mismatch.");
      assets.set(asset.path, asset);
    }
    validateAssets(assets);
    const input = {
      bytes: sourceBytes,
      uri: "tinta:/document.tinta",
      profile: "tinta" as const,
    };
    const program = unwrap(compile(input));
    requiredAssets(program, assets);
    const session = unwrap(createSession(program));
    session.destroy();

    return { source: input, assets };
  });
}

export async function validatedBundleEntries(
  bytes: Uint8Array,
): Promise<Result<ReadonlyMap<string, Uint8Array>>> {
  const opened = await openBundle(bytes);
  if (!opened.ok) return opened;
  return attempt(() => readZip(bytes));
}
