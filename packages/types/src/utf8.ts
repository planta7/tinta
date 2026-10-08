/** Strict, portable UTF-8. Reject overlong encodings, surrogates and truncation. */
export function decodeUtf8(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let part = "";

  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++]!;
    let point = a;
    let count = 0;
    let minimum = 0;

    if (a >= 0xc2 && a <= 0xdf) {
      count = 1;
      point = a & 31;
      minimum = 0x80;
    } else if (a >= 0xe0 && a <= 0xef) {
      count = 2;
      point = a & 15;
      minimum = 0x800;
    } else if (a >= 0xf0 && a <= 0xf4) {
      count = 3;
      point = a & 7;
      minimum = 0x10000;
    } else if (a >= 0x80) throw new Error("Invalid UTF-8 leading byte.");

    for (let j = 0; j < count; j++) {
      const b = bytes[i++];
      if (b === undefined || (b & 0xc0) !== 0x80)
        throw new Error("Invalid UTF-8 continuation.");
      point = (point << 6) | (b & 63);
    }

    if (
      point < minimum ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      throw new Error("Invalid UTF-8 scalar.");

    part += String.fromCodePoint(point);
    if (part.length >= 4096) {
      chunks.push(part);
      part = "";
    }
  }

  return chunks.join("") + part;
}

export function encodeUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(text));
  let offset = 0;

  for (const char of text) {
    const c = char.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff)
      throw new Error("Unpaired UTF-16 surrogate.");
    if (c < 128) bytes[offset++] = c;
    else if (c < 2048) {
      bytes[offset++] = 0xc0 | (c >> 6);
      bytes[offset++] = 0x80 | (c & 63);
    } else if (c < 65536) {
      bytes[offset++] = 0xe0 | (c >> 12);
      bytes[offset++] = 0x80 | ((c >> 6) & 63);
      bytes[offset++] = 0x80 | (c & 63);
    } else {
      bytes[offset++] = 0xf0 | (c >> 18);
      bytes[offset++] = 0x80 | ((c >> 12) & 63);
      bytes[offset++] = 0x80 | ((c >> 6) & 63);
      bytes[offset++] = 0x80 | (c & 63);
    }
  }

  return bytes;
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new Error("Unpaired UTF-16 surrogate.");
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return bytes;
}
