import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeUtf8, encodeUtf8, utf8ByteLength } from "./utf8.js";
import type { Artifact, Diagnostic, Result } from "./index.js";

export { decodeUtf8, encodeUtf8, utf8ByteLength };
export const limits = {
  sourceBytes: 2097152,
  assetBytes: 10485760,
  totalAssetBytes: 26214400,
  assetCount: 100,
  imagePixels: 20000000,
  bundleBytes: 31457280,
  htmlBytes: 41943040,
} as const;
export const hash = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export class ArtifactFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function reject(code: string, message: string): never {
  throw new ArtifactFailure(code, message);
}

export function diagnostic(code: string, message: string): Diagnostic {
  return {
    code,
    message,
    severity: "error",
    phase: "export",
    span: {
      uri: "tinta:artifact",
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 0, line: 1, column: 1 },
    },
  };
}

export function attempt<T>(operation: () => T): Result<T> {
  try {
    return { ok: true, value: operation(), diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          error instanceof ArtifactFailure ? error.code : "E_INTERNAL",
          error instanceof ArtifactFailure
            ? error.message
            : "Artifact operation failed.",
        ),
      ],
    };
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    const first = result.diagnostics[0];
    reject(
      first?.code ?? "E_EXPORT_INVALID",
      first?.message ?? "Invalid artifact input.",
    );
  }
  return result.value;
}

export function artifact(
  bytes: Uint8Array,
  mediaType: string,
  suggestedName: string,
): Artifact {
  return {
    bytes,
    mediaType,
    suggestedName,
    sha256: hash(bytes),
  };
}

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/** Bounded JSON grammar that rejects duplicate decoded keys before materialization. */
export function strictJson(
  text: string,
  maximum: number = limits.htmlBytes,
): unknown {
  if (text.length > maximum || encodeUtf8(text).length > maximum)
    reject("E_LIMIT", "JSON byte limit exceeded.");

  let offset = 0;
  let tokens = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? "!")) offset++;
  };
  const invalid = (): never =>
    reject("E_BUNDLE", "Invalid JSON or duplicate JSON key.");
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          invalid();
        }
      }
      if (char === "\\") offset++;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 256 || ++tokens > 2000000)
      reject("E_LIMIT", "JSON structure limit exceeded.");
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      offset++;
      const object: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      const array: unknown[] = [];
      const close = char === "{" ? "}" : "]";
      whitespace();
      if (text[offset] === close) {
        offset++;
        return char === "{" ? object : array;
      }
      while (offset < text.length) {
        whitespace();
        if (char === "{") {
          if (text[offset] !== '"') invalid();
          const key = string();
          if (Object.hasOwn(object, key)) invalid();
          whitespace();
          if (text[offset++] !== ":") invalid();
          object[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace();
        if (text[offset] === close) {
          offset++;
          return char === "{" ? object : array;
        }
        if (text[offset++] !== ",") invalid();
      }
      invalid();
    }

    const token =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(offset),
      );
    if (!token) return invalid();
    offset += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) invalid();

    return parsed;
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) invalid();

  return result;
}

export function object(
  value: unknown,
  keys: readonly string[],
  code = "E_BUNDLE",
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    reject(code, "Envelope fields do not match the contract.");
  return value as Record<string, unknown>;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let part = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1],
      c = bytes[i + 2];
    part +=
      alphabet[a >>> 2]! +
      alphabet[((a & 3) << 4) | ((b ?? 0) >>> 4)]! +
      (b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >>> 6)]!) +
      (c === undefined ? "=" : alphabet[c & 63]!);
    if (part.length >= 8192) {
      parts.push(part);
      part = "";
    }
  }
  return parts.join("") + part;
}
