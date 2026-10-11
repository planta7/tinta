import { implementationVersion } from "@tinta-lang/types/version";
import {
  restoreExportProgram,
  createSession,
} from "@tinta-lang/engine/runtime";
import { mountReader } from "./index.js";
import {
  strictJson,
  hash,
  encodeUtf8,
  object,
  unwrap,
  base64,
} from "@tinta-lang/types/common";
import {
  createAsset,
  validateAssets,
  normalizeAssetPath,
  imageDestinations,
} from "@tinta-lang/types/assets";
import type { Asset, ControlState } from "@tinta-lang/types";

/** The shell pins the exact validated payload, independently of the document source. */
export function start(expectedHash: string): void {
  const target = document.getElementById("tinta-content");
  try {
    if (!target) throw new Error("Missing document host.");
    const text = document.getElementById("tinta-payload")?.textContent ?? "";
    if (text.length > 41943040 || hash(encodeUtf8(text)) !== expectedHash)
      throw new Error("Payload hash mismatch.");

    const envelope = object(strictJson(text), [
      "kind",
      "formatVersion",
      "engineVersion",
      "abi",
      "program",
      "baseline",
      "assets",
    ]);
    if (
      envelope.kind !== "tinta-interactive" ||
      envelope.formatVersion !== "1.0" ||
      envelope.engineVersion !== implementationVersion ||
      envelope.abi !== "tinta-ir-1" ||
      !Array.isArray(envelope.assets) ||
      envelope.assets.length > 100
    )
      throw new Error("Invalid artifact envelope.");

    const program = unwrap(
      restoreExportProgram(
        envelope.program,
        hash(encodeUtf8(JSON.stringify(envelope.program))),
      ),
    );
    const baseline = object(envelope.baseline, [
      "kind",
      "formatVersion",
      "sourceSha256",
      "controls",
    ]);
    if (
      baseline.kind !== "tinta-state" ||
      baseline.formatVersion !== "1.0" ||
      baseline.sourceSha256 !== program.sourceSha256
    )
      throw new Error("Invalid answer snapshot.");

    const assets = new Map<string, Asset>();

    for (const item of envelope.assets) {
      const entry = object(item, ["path", "mime", "sha256", "base64"]);
      if (
        typeof entry.base64 !== "string" ||
        entry.base64.length > 13981016 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)
      )
        throw new Error("Invalid raster encoding.");

      const binary = atob(entry.base64),
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      if (base64(bytes) !== entry.base64)
        throw new Error("Noncanonical raster encoding.");

      const asset = unwrap(createAsset(bytes));
      if (
        asset.path !== entry.path ||
        asset.mime !== entry.mime ||
        asset.sha256 !== entry.sha256 ||
        assets.has(asset.path)
      )
        throw new Error("Invalid raster metadata.");
      assets.set(asset.path, asset);
    }
    validateAssets(assets);
    for (const destination of imageDestinations(program.flow))
      if (!assets.has(normalizeAssetPath(destination)))
        throw new Error("Missing raster resource.");

    const session = unwrap(
      createSession(program, { baseline: baseline.controls as ControlState }),
    );
    const candidate = document.createElement("div");
    const mounted = mountReader(
      session,
      { nativeElement: candidate },
      { assets },
    );
    if (!mounted.ok) {
      session.destroy();
      throw new Error("Reader initialization failed.");
    }
    target.replaceChildren(candidate);
    addEventListener(
      "pagehide",
      () => {
        mounted.value.destroy();
        session.destroy();
      },
      { once: true },
    );
  } catch {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent =
      "This interactive file could not initialize. The exported answers remain below.";
    target?.prepend(message);
  }
}
