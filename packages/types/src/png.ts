import { Unzlib } from "fflate";
import { reject } from "./common.js";

/** Stream decoded PNG scanlines; never allocate a pixel surface. */
export function validatePngData(
  parts: readonly Uint8Array[],
  width: number,
  height: number,
  depth: number,
  color: number,
  interlace: number,
): void {
  const bad = (): never =>
    reject("E_ASSET_TYPE", "Invalid PNG compressed scanlines.");
  const channels = color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 1;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows: {
    length: number;
    count: number;
  }[] = [];
  let expected = 0;

  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!)),
      count = Math.max(0, Math.ceil((height - y!) / dy!));
    if (!columns || !count) continue;
    const length = 1 + Math.ceil((columns * channels * depth) / 8);
    rows.push({ length, count });
    expected += length * count;
  }

  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length < 6) bad();
  const packed = new Uint8Array(length);
  let at = 0;

  for (const part of parts) {
    packed.set(part, at);
    at += part.length;
  }
  if (
    (packed[0]! & 15) !== 8 ||
    packed[0]! >>> 4 > 7 ||
    (packed[0]! * 256 + packed[1]!) % 31 ||
    packed[1]! & 32
  )
    bad();

  let count = 0,
    pass = 0,
    row = 0,
    column = 0,
    a = 1,
    b = 0;
  const inflater = new Unzlib((chunk) => {
    count += chunk.length;
    if (count > expected) bad();
    for (const byte of chunk) {
      if (column === 0 && byte > 4) bad();
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
      if (++column === rows[pass]!.length) {
        column = 0;
        if (++row === rows[pass]!.count) {
          row = 0;
          pass++;
        }
      }
    }
  });
  try {
    for (let offset = 0; offset < packed.length; offset += 1024)
      inflater.push(
        packed.subarray(offset, offset + 1024),
        offset + 1024 >= packed.length,
      );
  } catch {
    bad();
  }

  const checksum = new DataView(packed.buffer).getUint32(packed.length - 4);
  if (count !== expected || checksum !== (b * 65536 + a) >>> 0) bad();
}
