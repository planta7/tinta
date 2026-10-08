import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fc from "fast-check";
import {
  compile,
  createSession,
  encodeProgram,
} from "../../packages/engine/dist/index.js";
import { restoreExportProgram } from "../../packages/engine/dist/runtime.js";
import {
  createAsset,
  inspectImage,
  validateAssets,
  normalizeAssetPath,
  exportHtml,
  packSource,
  openBundle,
  validatedBundleEntries,
  strictJson,
  encodeUtf8,
  hash,
  unwrap,
} from "../../packages/artifacts/dist/index.js";
import {
  attempt,
  base64,
  crc32,
  canonicalJson,
  object,
} from "../../packages/types/dist/common.js";
import { readZip, writeZip } from "../../packages/artifacts/dist/zip.js";
const { zipSync, zlibSync } = createRequire(
  new URL("../../packages/artifacts/package.json", import.meta.url),
)("fflate");
const rasters = JSON.parse(
  readFileSync("tests/fixtures/rasters.json", "utf8"),
).rasters;
const bytes = (mime) =>
  Uint8Array.from(
    Buffer.from(rasters.find((image) => image.mime === mime).base64, "base64"),
  );
const png = bytes("image/png"),
  asset = unwrap(createAsset(png));
const program = (text) =>
  unwrap(
    compile({
      text,
      profile: "tinta",
      uri: "tinta:/document.tinta",
    }),
  );
const validBundle = async () =>
  unwrap(await packSource(program("# Source\n"), new Map())).bytes;

for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
  test(`validates and preserves a ${mime} raster`, () => {
    const input = bytes(mime),
      result = unwrap(createAsset(input));
    expect(result.mime).toBe(mime);
    expect(inspectImage(input)).toMatchObject({ width: 2, height: 2 });
    expect(result.bytes).toEqual(input);
    for (const length of [1, 4, 12, input.length - 1])
      expect(createAsset(input.subarray(0, length)).ok).toBe(false);
  });
}
test("rejects APNG and animated WebP chunks even when checksums agree", () => {
  const control = new Uint8Array(20),
    view = new DataView(control.buffer);
  view.setUint32(0, 8);
  control.set(encodeUtf8("acTL"), 4);
  view.setUint32(16, crc32(control.subarray(4, 16)));
  const animation = Uint8Array.from([
    ...png.slice(0, 33),
    ...control,
    ...png.slice(33),
  ]);
  expect(createAsset(animation).diagnostics[0].code).toBe("E_ASSET_TYPE");
  const webp = bytes("image/webp");
  webp.set(encodeUtf8("ANIM"), 12);
  expect(createAsset(webp).ok).toBe(false);
});
test("rejects PNG compressed corruption even with a fresh chunk CRC", () => {
  const corrupted = png.slice(),
    view = new DataView(corrupted.buffer);
  let offset = 8;
  while (
    String.fromCharCode(...corrupted.slice(offset + 4, offset + 8)) !== "IDAT"
  )
    offset += view.getUint32(offset) + 12;
  const length = view.getUint32(offset);
  corrupted[offset + 8] ^= 64;
  view.setUint32(
    offset + 8 + length,
    crc32(corrupted.slice(offset + 4, offset + 8 + length)),
  );
  expect(createAsset(corrupted).ok).toBe(false);
});
test("rejects raster limits, mismatched capability keys, MIME and hashes", () => {
  expect(createAsset(new Uint8Array(10485761)).diagnostics[0].code).toBe(
    "E_LIMIT",
  );
  expect(() => validateAssets(new Map([["../a", asset]]))).toThrow();
  for (const changed of [
    { ...asset, mime: "image/jpeg" },
    { ...asset, path: "assets/x.png" },
    { ...asset, sha256: "0".repeat(64) },
  ])
    expect(() => validateAssets(new Map([["photo.png", changed]]))).toThrow();
  expect(
    validateAssets(new Map([["literal%20.png", asset]])).has("literal%20.png"),
  ).toBe(true);
  expect(normalizeAssetPath("literal%2520.png")).toBe("literal%20.png");
});
test("authenticates compiled export bytes before runtime hydration", () => {
  const ir = encodeProgram(
    program("@slider value = 1 (min: 0, max: 2)\n\n{{value}}\n"),
  );
  const expected = hash(encodeUtf8(JSON.stringify(ir)));
  const restored = unwrap(restoreExportProgram(ir, expected));
  const session = unwrap(createSession(restored));
  expect(unwrap(session.setControl("value", 2)).state.value).toBe(2);
  session.destroy();
  expect(restoreExportProgram(ir, "0".repeat(64)).diagnostics[0].code).toBe(
    "E_HASH_MISMATCH",
  );
  const extra = { ...ir, extra: true };
  expect(
    restoreExportProgram(extra, hash(encodeUtf8(JSON.stringify(extra)))).ok,
  ).toBe(false);
  const altered = { ...ir, sourceSha256: "0".repeat(64) };
  expect(
    restoreExportProgram(altered, hash(encodeUtf8(JSON.stringify(altered)))).ok,
  ).toBe(false);
});
test("reads permitted deflate, rejects actual inflation above advertised size", async () => {
  const entries = readZip(await validBundle());
  const compressed = zipSync(Object.fromEntries(entries), { level: 6 });
  expect((await openBundle(compressed)).ok).toBe(true);
  const changed = compressed.slice(),
    view = new DataView(changed.buffer);
  const end = changed.length - 22,
    central = view.getUint32(end + 16, true);
  view.setUint32(22, 1, true);
  view.setUint32(central + 24, 1, true);
  expect((await openBundle(changed)).diagnostics[0].code).toBe("E_LIMIT");
});
const changes = [
  ["local signature", (v) => v.setUint32(0, 0, true)],
  [
    "encryption",
    (v, c) => {
      v.setUint16(6, 1, true);
      v.setUint16(c + 8, 1, true);
    },
  ],
  ["ZIP64 version", (v, c) => v.setUint16(c + 6, 45, true)],
  ["method", (v, c) => v.setUint16(c + 10, 99, true)],
  ["multidisk", (v, c, e) => v.setUint16(e + 4, 1, true)],
  ["disk counts", (v, c, e) => v.setUint16(e + 8, 1, true)],
  ["central offset", (v, c, e) => v.setUint32(e + 16, 1, true)],
  ["central signature", (v, c) => v.setUint32(c, 0, true)],
  ["entry limit", (v, c, e) => v.setUint16(e + 10, 103, true)],
  ["directory", (v, c) => v.setUint32(c + 38, 16, true)],
  ["symlink", (v, c) => v.setUint32(c + 38, 0xa1ff0000, true)],
  ["device", (v, c) => v.setUint32(c + 38, 0x21a40000, true)],
  ["size sentinel", (v, c) => v.setUint32(c + 24, 0xffffffff, true)],
  ["oversized", (v, c) => v.setUint32(c + 24, 31457281, true)],
  ["local CRC", (v) => v.setUint32(14, 0, true)],
  [
    "central CRC",
    (v, c) => {
      v.setUint32(14, 0, true);
      v.setUint32(c + 16, 0, true);
    },
  ],
  ["length mismatch", (v, c) => v.setUint16(c + 28, 5000, true)],
  ["header offset", (v, c) => v.setUint32(c + 42, 1, true)],
];
for (const [name, change] of changes)
  test(`rejects ZIP ${name} before extraction`, async () => {
    const valid = await validBundle(),
      bad = valid.slice(),
      view = new DataView(bad.buffer),
      end = bad.length - 22,
      central = view.getUint32(end + 16, true);
    change(view, central, end);
    expect((await openBundle(bad)).ok).toBe(false);
  });
test("rejects missing, extra, duplicate manifest assets and metadata mismatches", async () => {
  const packed = unwrap(
    await packSource(
      program("![photo](photo.png)\n"),
      new Map([["photo.png", asset]]),
    ),
  ).bytes;
  const original = readZip(packed),
    manifest = JSON.parse(
      new TextDecoder().decode(original.get("manifest.json")),
    );
  const variants = [
    { ...manifest, kind: "wrong" },
    { ...manifest, formatVersion: "9.0" },
    { ...manifest, extra: 1 },
    { ...manifest, assets: {} },
    { ...manifest, assets: [] },
    { ...manifest, assets: [...manifest.assets, ...manifest.assets] },
    {
      ...manifest,
      assets: [
        { ...manifest.assets[0], path: "assets/" + "0".repeat(64) + ".png" },
      ],
    },
    { ...manifest, assets: [{ ...manifest.assets[0], mime: "image/jpeg" }] },
    { ...manifest, assets: [{ ...manifest.assets[0], bytes: 1 }] },
    {
      ...manifest,
      assets: [{ ...manifest.assets[0], sha256: "0".repeat(64) }],
    },
  ];
  for (const value of variants) {
    const entries = new Map(original);
    entries.set("manifest.json", encodeUtf8(canonicalJson(value)));
    expect((await openBundle(writeZip(entries))).ok).toBe(false);
  }
  expect(unwrap(await validatedBundleEntries(packed)).size).toBe(3);
  expect((await validatedBundleEntries(Uint8Array.of(0))).ok).toBe(false);
});
test("empty source and Unicode source survive deflate round trips", async () => {
  for (const text of ["", "\ufeff# \t𐐀\r\n\r\nContent.\r\n"]) {
    const packed = unwrap(await packSource(program(text), new Map()));
    const entries = readZip(packed.bytes);
    const opened = unwrap(
      await openBundle(zipSync(Object.fromEntries(entries), { level: 9 })),
    );
    expect(opened.source.bytes).toEqual(encodeUtf8(text));
  }
});
test("strict JSON agrees with native parsing on bounded generated data", () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
      const text = JSON.stringify(value);
      expect(JSON.stringify(strictJson(text))).toBe(text);
    }),
    { numRuns: 1000, seed: 90345 },
  );
  expect(() => object([], [])).toThrow();
  expect(() => strictJson('"\\q"')).toThrow();
  expect(
    attempt(() => {
      throw new Error("private input");
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "E_INTERNAL", message: "Artifact operation failed." },
    ],
  });
  expect(base64(Uint8Array.of(1))).toBe("AQ==");
  expect(base64(Uint8Array.of(1, 2))).toBe("AQI=");
  const long = Uint8Array.from({ length: 20000 }, (_, i) => i % 256);
  expect(base64(long)).toBe(Buffer.from(long).toString("base64"));
});
test("source rebasing traverses nested lists and table image cells", async () => {
  const text =
    "- ![item](photo.png)\n\n| Item |\n| --- |\n| ![cell](photo.png) |\n";
  const packed = unwrap(
    await packSource(program(text), new Map([["photo.png", asset]])),
  );
  expect((await openBundle(packed.bytes)).ok).toBe(true);
});
test("invalid export options and Markdown source bundles fail explicitly", async () => {
  const compiled = unwrap(
      compile({
        text: "# Plain",
        profile: "markdown",
        uri: "tinta:plain",
      }),
    ),
    session = unwrap(createSession(compiled));
  expect((await packSource(compiled, new Map())).ok).toBe(false);
  expect(
    (
      await exportHtml(session, new Map(), {
        format: "pdf",
        answers: "initial",
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await exportHtml(session, new Map(), {
        format: "static",
        answers: "screen",
      })
    ).ok,
  ).toBe(false);
  session.destroy();
});
test("PNG filter and decompressed size failures reject valid zlib streams", () => {
  function chunk(name, data) {
    const result = new Uint8Array(data.length + 12),
      view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(encodeUtf8(name), 4);
    result.set(data, 8);
    view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)));
    return result;
  }
  const header = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  for (const raw of [
    Uint8Array.of(5, 0, 0, 0, 0),
    Uint8Array.of(0),
    new Uint8Array(10),
  ]) {
    const input = Uint8Array.from([
      ...png.slice(0, 8),
      ...chunk("IHDR", header),
      ...chunk("IDAT", zlibSync(raw)),
      ...chunk("IEND", new Uint8Array()),
    ]);
    expect(createAsset(input).ok).toBe(false);
  }
});

test("streamed ZIP data descriptors and permitted extra fields round trip", async () => {
  const { Zip, ZipPassThrough } = createRequire(
    new URL("../../packages/artifacts/package.json", import.meta.url),
  )("fflate");
  const entries = readZip(await validBundle());
  const chunks = [];
  const stream = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, data] of entries) {
    const file = new ZipPassThrough(name);
    stream.add(file);
    file.push(data, true);
  }
  stream.end();
  const packed = Uint8Array.from(Buffer.concat(chunks));
  expect((await openBundle(packed)).ok).toBe(true);
  const broken = packed.slice();
  const signature = Buffer.from(broken).indexOf(Buffer.from([80, 75, 7, 8]));
  new DataView(broken.buffer).setUint32(signature + 4, 0, true);
  expect((await openBundle(broken)).ok).toBe(false);

  const extra = zipSync(Object.fromEntries(entries), {
    extra: { 12345: Uint8Array.of(1, 2) },
  });
  expect((await openBundle(extra)).ok).toBe(true);
  const zip64 = extra.slice();
  const view = new DataView(zip64.buffer);
  view.setUint16(30 + view.getUint16(26, true), 1, true);
  expect((await openBundle(zip64)).ok).toBe(false);
});

test("rejects ZIP duplicate, case-colliding, absolute and encoded paths", async () => {
  const entries = readZip(await validBundle());
  for (const path of [
    "/absolute",
    "%2e%2e/escape",
    "MANIFEST.JSON",
    "assets/",
  ]) {
    const changed = new Map(entries);
    changed.set(path, Uint8Array.of(1));
    expect((await openBundle(writeZip(changed))).ok).toBe(false);
  }
  const only = new Map([["manifest.json", entries.get("manifest.json")]]);
  expect((await openBundle(writeZip(only))).ok).toBe(false);
  expect(() =>
    writeZip(new Map([["document.tinta", new Uint8Array(31457280)]])),
  ).toThrow();
  expect((await openBundle(new Uint8Array(31457281))).diagnostics[0].code).toBe(
    "E_LIMIT",
  );
});

test("static image attributes, tasks, breaks and selected answers remain typed", async () => {
  const text = [
    "@toggle checked = false",
    "",
    '![caption](photo.png "Image title")',
    "",
    "- [x] Completed",
    "- [ ] Pending",
    "",
    "First  ",
    "second",
    "",
    "---",
    "",
    '@details "More"',
    "Details.",
    "@end",
    "",
  ].join("\n");
  const session = unwrap(createSession(program(text)));
  unwrap(session.setControl("checked", true));
  try {
    const result = unwrap(
      await exportHtml(session, new Map([["photo.png", asset]]), {
        format: "static",
        answers: "current",
      }),
    );
    const html = new TextDecoder().decode(result.bytes);
    expect(html).toContain('title="Image title"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("<br>");
    expect(html).toContain("<hr>");
    expect(html).toContain("open");
    expect(html).toContain("disabled");
  } finally {
    session.destroy();
  }
});

test("static expansion stops at its byte budget across nested siblings", async () => {
  const { staticNodes } = await import("../../packages/artifacts/dist/html.js");
  const text = { kind: "text", value: "&".repeat(4096) };
  const node = {
    kind: "element",
    tag: "p",
    attributes: {},
    children: [text],
  };
  const budget = { bytes: 41943040 - 21000 };
  expect(staticNodes([node], new Map(), budget)).toContain("&amp;");
  expect(() => staticNodes([node], new Map(), budget)).toThrow(
    "HTML byte limit",
  );
});

test("invalid UTF-8 in a local ZIP filename is a bundle validation failure", async () => {
  const bytes = await validBundle();
  const altered = Uint8Array.from(bytes);
  altered[30] = 0xff;
  const result = await openBundle(altered);
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0].code).toBe("E_BUNDLE");
});
