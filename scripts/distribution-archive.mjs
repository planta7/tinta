import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../packages/artifacts/package.json", import.meta.url),
);
const { zipSync, unzipSync } = require("fflate");
const maxArchiveBytes = 128 * 1024 * 1024;
const maxEntries = 10000;
const sourceExceptions = JSON.parse(
  readFileSync(
    new URL(
      "../toolchain/distribution-source-exceptions.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safePath(path) {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    (path !== "[Content_Types].xml" && !/^[A-Za-z0-9_.@/-]+$/.test(path)) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) =>
        ["", ".", "..", "__proto__", "constructor", "prototype"].includes(part),
      ) ||
    /(?:^|\/)(?:\.local|\.git|\.env(?:\..*)?|node_modules|agents\.md)(?:\/|$)/i.test(
      path,
    )
  )
    throw new Error(`Unsafe distribution path: ${path}`);
}

export function inspectEntries(entries, expected, { source = false } = {}) {
  const names = Object.keys(entries).sort();
  if (
    names.length > maxEntries ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify([...expected].sort())
  )
    throw new Error("Missing or unexpected archive entries.");
  let total = 0;
  return names.map((path) => {
    safePath(path);
    const bytes = Buffer.from(entries[path]);
    total += bytes.length;
    if (total > maxArchiveBytes)
      throw new Error("Archive size limit exceeded.");
    let text = bytes.toString("utf8");
    // Reviewed synthetic hostile strings are exempt by exact line digest only.
    if (source) {
      const allowed = new Set(sourceExceptions[path] ?? []);
      text = text
        .split("\n")
        .filter((line) => !allowed.has(digest(line)))
        .join("\n");
    }
    if (
      /(?<![A-Za-z0-9])\/(?:Users|home|root|private\/tmp)\/|[A-Z]:[\\/]+Users[\\/]+|\.local\/automation|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sourceMappingURL=|AKIA[0-9A-Z]{16}/.test(
        text,
      )
    )
      throw new Error(`Private or development content: ${path}`);
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
}

export function zipEntries(entries) {
  inspectEntries(entries, Object.keys(entries), { source: true });
  return zipSync(
    Object.fromEntries(
      Object.keys(entries)
        .sort()
        .map((path) => [
          path,
          [entries[path], { mtime: new Date("2000-01-01T00:00:00Z") }],
        ]),
    ),
    { level: 9 },
  );
}

export function readZip(bytes) {
  if (bytes.length > maxArchiveBytes)
    throw new Error("Archive size limit exceeded.");
  let total = 0;
  let count = 0;
  const seen = new Set();
  return unzipSync(bytes, {
    filter(entry) {
      safePath(entry.name);
      total += entry.originalSize;
      if (
        ++count > maxEntries ||
        total > maxArchiveBytes ||
        seen.has(entry.name)
      )
        throw new Error("Duplicate entry or archive size limit exceeded.");
      seen.add(entry.name);
      return true;
    },
  });
}

/** Read the regular USTAR entries produced by pnpm pack; fail closed on other types. */
export function readTarball(bytes) {
  if (bytes.length > maxArchiveBytes)
    throw new Error("Archive size limit exceeded.");
  const tar = gunzipSync(bytes, { maxOutputLength: maxArchiveBytes });
  const entries = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Trailing tar content.");
      return entries;
    }
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const octal = (start, length) => {
      const value = field(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar number.");
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(148, 8) || !["0", ""].includes(field(156, 1)))
      throw new Error("Unsupported tar header.");
    const prefix = field(345, 155);
    const path = (prefix ? prefix + "/" : "") + field(0, 100);
    safePath(path);
    const size = octal(124, 12);
    if (!path.startsWith("package/") || Object.hasOwn(entries, path.slice(8)))
      throw new Error("Invalid or duplicate package entry.");
    offset += 512;
    if (offset + size > tar.length || Object.keys(entries).length >= maxEntries)
      throw new Error("Truncated or oversized tarball.");
    entries[path.slice(8)] = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("Missing tar terminator.");
}
