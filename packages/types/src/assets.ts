import type {
  Asset,
  AssetStore,
  DocNode,
  Program,
  ResolvedNode,
  Result,
} from "./index.js";
import { attempt, crc32, hash, limits, reject } from "./common.js";

import { validatePngData } from "./png.js";

export function normalizeAssetPath(destination: string): string {
  let path: string;
  try {
    path = decodeURIComponent(destination);
  } catch {
    return reject("E_ASSET_PATH", "Invalid image path encoding.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//"))
    reject("E_ASSET_EXTERNAL", "Only granted local images are permitted.");
  if (path.startsWith("./")) path = path.slice(2);
  return normalizedPath(path);
}
function normalizedPath(path: string): string {
  if (
    /[\\?#:]/.test(path) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    reject("E_ASSET_PATH", "Unsafe image path.");
  return path;
}

/** Validate container structure and dimensions without trusting suffixes or metadata. */
export function inspectImage(bytes: Uint8Array): {
  mime: Asset["mime"];
  extension: string;
  width: number;
  height: number;
} {
  if (!bytes.length || bytes.length > limits.assetBytes)
    reject("E_LIMIT", "Image byte limit exceeded.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (): never =>
    reject("E_ASSET_TYPE", "Unsupported, animated or malformed raster image.");
  const word = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let width = 0,
    height = 0;
  let mime: Asset["mime"], extension: string;
  if (
    bytes.length >= 33 &&
    bytes
      .slice(0, 8)
      .every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])
  ) {
    mime = "image/png";
    extension = "png";
    const parts: Uint8Array[] = [];
    let offset = 8,
      data = false,
      end = false,
      palette = false,
      dataEnded = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const tag = word(offset + 4);
      if (
        !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(tag) ||
        length > bytes.length - offset - 12 ||
        view.getUint32(offset + 8 + length) !==
          crc32(bytes.subarray(offset + 4, offset + 8 + length))
      )
        bad();
      if (offset === 8) {
        if (tag !== "IHDR" || length !== 13) bad();
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        const depth = bytes[offset + 16]!,
          color = bytes[offset + 17]!;
        if (
          !(
            color === 0
              ? [1, 2, 4, 8, 16]
              : color === 3
                ? [1, 2, 4, 8]
                : [2, 4, 6].includes(color)
                  ? [8, 16]
                  : []
          ).includes(depth) ||
          bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 ||
          bytes[offset + 20]! > 1
        )
          bad();
      } else if (tag === "IHDR") bad();
      if (["acTL", "fcTL", "fdAT"].includes(tag)) bad();
      if (/^[A-Z]/.test(tag) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(tag))
        bad();
      if (tag === "PLTE") {
        if (
          palette ||
          data ||
          !length ||
          length > 768 ||
          length % 3 ||
          bytes[25] === 0 ||
          bytes[25] === 4
        )
          bad();
        palette = true;
      }
      if (tag === "IDAT") {
        if (dataEnded || (bytes[25] === 3 && !palette)) bad();
        data = true;
        parts.push(bytes.subarray(offset + 8, offset + 8 + length));
      } else if (data) dataEnded = true;
      offset += length + 12;
      if (tag === "IEND") {
        if (length || !data || offset !== bytes.length) bad();
        end = true;
        break;
      }
    }
    if (!end) bad();
    if (!width || !height) bad();
    if (width * height > limits.imagePixels)
      reject("E_LIMIT", "Image pixel limit exceeded.");
    validatePngData(parts, width, height, bytes[24]!, bytes[25]!, bytes[28]!);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    extension = "jpg";
    let offset = 2,
      scanned = false,
      ended = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) bad();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) {
        ended = true;
        break;
      }
      if (
        marker === undefined ||
        marker === 0 ||
        marker === 216 ||
        offset + 2 > bytes.length
      )
        bad();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) bad();
      if ([192, 193, 194].includes(marker!)) {
        if (length < 8 || width || bytes[offset + 2] !== 8) bad();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        if (length !== 8 + 3 * bytes[offset + 7]!) bad();
      }
      offset += length;
      if (marker === 218) {
        scanned = true;
        while (offset < bytes.length) {
          if (bytes[offset] !== 255) {
            offset++;
            continue;
          }
          const next = bytes[offset + 1];
          if (
            next === 0 ||
            (next !== undefined && next >= 208 && next <= 215)
          ) {
            offset += 2;
            continue;
          }
          break;
        }
      }
    }
    if (!scanned || !ended || offset !== bytes.length) bad();
  } else if (bytes.length >= 20 && word(0) === "RIFF" && word(8) === "WEBP") {
    mime = "image/webp";
    extension = "webp";
    if (view.getUint32(4, true) + 8 !== bytes.length) bad();
    let offset = 12,
      image = false;
    let canvasWidth: number | undefined;
    let canvasHeight: number | undefined;
    while (offset + 8 <= bytes.length) {
      const tag = word(offset),
        length = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (length > bytes.length - start || ["ANIM", "ANMF"].includes(tag))
        bad();
      if (tag === "VP8X") {
        if (
          offset !== 12 ||
          length !== 10 ||
          bytes[start]! & 0xc3 ||
          bytes[start + 1] ||
          bytes[start + 2] ||
          bytes[start + 3]
        )
          bad();
        canvasWidth =
          1 +
          bytes[start + 4]! +
          bytes[start + 5]! * 256 +
          bytes[start + 6]! * 65536;
        canvasHeight =
          1 +
          bytes[start + 7]! +
          bytes[start + 8]! * 256 +
          bytes[start + 9]! * 65536;
      } else if (tag === "VP8 ") {
        if (
          image ||
          length < 10 ||
          bytes[start]! & 1 ||
          bytes[start + 3] !== 157 ||
          bytes[start + 4] !== 1 ||
          bytes[start + 5] !== 42
        )
          bad();
        width = view.getUint16(start + 6, true) & 16383;
        height = view.getUint16(start + 8, true) & 16383;
        image = true;
      } else if (tag === "VP8L") {
        if (
          image ||
          length < 5 ||
          bytes[start] !== 47 ||
          bytes[start + 4]! >> 5
        )
          bad();
        const bits = view.getUint32(start + 1, true);
        width = (bits & 16383) + 1;
        height = ((bits >>> 14) & 16383) + 1;
        image = true;
      } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(tag)) bad();
      offset = start + length + (length & 1);
    }
    if (!image || offset !== bytes.length) bad();
    if (
      canvasWidth !== undefined &&
      (canvasWidth !== width || canvasHeight !== height)
    )
      bad();
  } else return bad();
  if (!width || !height) bad();
  if (width * height > limits.imagePixels)
    reject("E_LIMIT", "Image pixel limit exceeded.");
  return { mime, extension, width, height };
}
export function createAsset(bytes: Uint8Array): Result<Asset> {
  return attempt(() => {
    const image = inspectImage(bytes);
    const sha256 = hash(bytes);
    return {
      path: `assets/${sha256}.${image.extension}`,
      mime: image.mime,
      sha256,
      bytes: Uint8Array.from(bytes),
    };
  });
}
export function validateAssets(assets: AssetStore): Map<string, Asset> {
  const result = new Map<string, Asset>();
  const unique = new Set<string>();
  let total = 0;
  for (const [key, asset] of assets) {
    if (normalizedPath(key) !== key)
      reject("E_ASSET_PATH", "Asset keys must be normalized.");
    const image = inspectImage(asset.bytes);
    const digest = hash(asset.bytes);
    if (
      asset.sha256 !== digest ||
      asset.path !== `assets/${digest}.${image.extension}`
    )
      reject(
        "E_HASH_MISMATCH",
        "Asset hash does not match its canonical path.",
      );
    if (asset.mime !== image.mime)
      reject("E_ASSET_TYPE", "Asset MIME does not match bytes.");
    if (!unique.has(digest)) {
      total += asset.bytes.length;
      unique.add(digest);
    }
    if (
      unique.size > limits.assetCount ||
      total > limits.totalAssetBytes ||
      result.size >= 100000
    )
      reject("E_LIMIT", "Asset store limit exceeded.");
    result.set(key, { ...asset, bytes: Uint8Array.from(asset.bytes) });
  }
  return result;
}
export function imageDestinations(
  nodes: readonly (DocNode | ResolvedNode)[],
): string[] {
  const destinations: string[] = [];
  for (const node of nodes) {
    if (node.kind === "image") destinations.push(node.destination);
    if ("children" in node)
      destinations.push(...imageDestinations(node.children));
    if (node.kind === "list")
      for (const item of node.items)
        destinations.push(...imageDestinations(item.children));
    if (node.kind === "markdown-table")
      for (const row of [node.header, ...node.rows])
        for (const cell of row) destinations.push(...imageDestinations(cell));
  }
  return [...new Set(destinations)];
}
export function requiredAssets(
  program: Program,
  assets: AssetStore,
): Map<string, Asset> {
  const checked = validateAssets(assets);
  const selected = new Map<string, Asset>();
  for (const destination of imageDestinations(program.flow)) {
    const key = normalizeAssetPath(destination),
      asset = checked.get(key);
    if (!asset)
      reject("E_ASSET_MISSING", "A required local image was not supplied.");
    selected.set(key, asset);
  }
  return selected;
}
