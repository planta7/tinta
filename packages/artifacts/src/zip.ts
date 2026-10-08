import { Inflate } from "fflate";
import { crc32, decodeUtf8, encodeUtf8, limits, reject } from "./common.js";

export function writeZip(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
  let localSize = 0,
    centralSize = 0;
  for (const [name, data] of entries) {
    localSize += 30 + encodeUtf8(name).length + data.length;
    centralSize += 46 + encodeUtf8(name).length;
  }
  if (localSize + centralSize + 22 > limits.bundleBytes)
    reject("E_LIMIT", "Bundle byte limit exceeded.");
  const bytes = new Uint8Array(localSize + centralSize + 22),
    view = new DataView(bytes.buffer);
  let offset = 0,
    central = localSize;
  for (const [name, data] of entries) {
    const path = encodeUtf8(name),
      crc = crc32(data);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x800, true);
    view.setUint16(offset + 12, 33, true);
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, data.length, true);
    view.setUint32(offset + 22, data.length, true);
    view.setUint16(offset + 26, path.length, true);
    bytes.set(path, offset + 30);
    bytes.set(data, offset + 30 + path.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 0x314, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0x800, true);
    view.setUint16(central + 14, 33, true);
    view.setUint32(central + 16, crc, true);
    view.setUint32(central + 20, data.length, true);
    view.setUint32(central + 24, data.length, true);
    view.setUint16(central + 28, path.length, true);
    view.setUint32(central + 38, 0x81a40000, true);
    view.setUint32(central + 42, offset, true);
    bytes.set(path, central + 46);
    offset += 30 + path.length + data.length;
    central += 46 + path.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, entries.size, true);
  view.setUint16(central + 10, entries.size, true);
  view.setUint32(central + 12, centralSize, true);
  view.setUint32(central + 16, localSize, true);
  return bytes;
}

/** Validate the complete directory and local records before returning any bytes. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > limits.bundleBytes)
    reject("E_LIMIT", "Compressed bundle limit exceeded.");
  const invalid = (): never =>
    reject("E_BUNDLE", "Invalid ZIP structure, CRC or entry metadata.");
  if (bytes.length < 22) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > bytes.length) invalid();
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > bytes.length) invalid();
    return view.getUint32(offset, true);
  };
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50)
    end--;
  if (
    end < 0 ||
    u32(end) !== 0x06054b50 ||
    end + 22 + u16(end + 20) !== bytes.length ||
    u16(end + 4) ||
    u16(end + 6)
  )
    invalid();
  const count = u16(end + 10),
    centralSize = u32(end + 12),
    centralStart = u32(end + 16);
  if (count > 102) reject("E_LIMIT", "ZIP entry limit exceeded.");
  if (count < 2 || count !== u16(end + 8) || centralStart + centralSize !== end)
    invalid();
  const result = new Map<string, Uint8Array>(),
    seen = new Set<string>();
  let offset = centralStart,
    nextLocal = 0,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (u32(offset) !== 0x02014b50) invalid();
    const flags = u16(offset + 8),
      method = u16(offset + 10),
      crc = u32(offset + 16),
      compressed = u32(offset + 20),
      size = u32(offset + 24),
      nameLength = u16(offset + 28),
      extra = u16(offset + 30),
      comment = u16(offset + 32),
      local = u32(offset + 42),
      mode = u32(offset + 38) >>> 16;
    if (
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      u16(offset + 34) ||
      u16(offset + 6) > 20 ||
      local !== nextLocal ||
      [size, compressed, local].includes(0xffffffff) ||
      (mode & 0xf000 && (mode & 0xf000) !== 0x8000) ||
      u32(offset + 38) & 16
    )
      invalid();
    if (offset + 46 + nameLength + extra + comment > end) invalid();
    let name: string;
    try {
      name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      return invalid();
    }
    if (!(
      name === "manifest.json" ||
      name === "document.tinta" ||
      /^assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)
    ))
      reject("E_ASSET_PATH", "Unexpected or unsafe ZIP entry.");
    if (seen.has(name.toLowerCase())) invalid();
    seen.add(name.toLowerCase());
    const checkExtra = (start: number, length: number): void => {
      let at = start;
      while (at < start + length) {
        if (at + 4 > start + length || u16(at) === 1) invalid();
        at += 4 + u16(at + 2);
      }
      if (at !== start + length) invalid();
    };
    checkExtra(offset + 46 + nameLength, extra);
    if (
      u32(local) !== 0x04034b50 ||
      u16(local + 4) > 20 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== nameLength
    )
      invalid();
    const localExtra = u16(local + 28),
      dataStart = local + 30 + nameLength + localExtra;
    checkExtra(local + 30 + nameLength, localExtra);
    if (
      dataStart + compressed > centralStart ||
      bytes
        .subarray(local + 30, local + 30 + nameLength)
        .some((byte, index) => byte !== bytes[offset + 46 + index])
    )
      invalid();
    if (
      !(flags & 8) &&
      (u32(local + 14) !== crc ||
        u32(local + 18) !== compressed ||
        u32(local + 22) !== size)
    )
      invalid();
    const ceiling =
      name === "document.tinta"
        ? limits.sourceBytes
        : name === "manifest.json"
          ? 65536
          : limits.assetBytes;
    if (size > ceiling || expanded + size > limits.bundleBytes)
      reject("E_LIMIT", "Expanded bundle limit exceeded.");
    const packed = bytes.subarray(dataStart, dataStart + compressed);
    let data: Uint8Array;
    if (method === 0) {
      if (compressed !== size) invalid();
      data = packed.slice();
    } else {
      const chunks: Uint8Array[] = [];
      let actual = 0;
      const inflater = new Inflate((chunk) => {
        actual += chunk.length;
        if (
          actual > size ||
          actual > ceiling ||
          expanded + actual > limits.bundleBytes
        )
          reject("E_LIMIT", "Actual inflation limit exceeded.");
        chunks.push(chunk);
      });
      try {
        for (let at = 0; at < packed.length; at += 1024)
          inflater.push(
            packed.subarray(at, at + 1024),
            at + 1024 >= packed.length,
          );
      } catch (error) {
        if (error instanceof Error && "code" in error) throw error;
        invalid();
      }
      data = new Uint8Array(actual);
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
      }
    }
    if (data.length !== size || crc32(data) !== crc) invalid();
    expanded += data.length;
    result.set(name, data);
    nextLocal = dataStart + compressed;
    if (flags & 8) {
      if (u32(nextLocal) === 0x08074b50) nextLocal += 4;
      if (
        u32(nextLocal) !== crc ||
        u32(nextLocal + 4) !== compressed ||
        u32(nextLocal + 8) !== size
      )
        invalid();
      nextLocal += 12;
    }
    offset += 46 + nameLength + extra + comment;
  }
  if (
    offset !== end ||
    nextLocal !== centralStart ||
    !result.has("manifest.json") ||
    !result.has("document.tinta")
  )
    invalid();
  return result;
}
