import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { parse } from "../../packages/syntax/dist/index.js";
import { Source } from "../../packages/syntax/dist/source.js";
import { Budget } from "../../packages/engine/dist/common.js";
import {
  compile,
  createSession,
  importCsv,
  importJson,
} from "../../packages/engine/dist/index.js";
import {
  createAsset,
  validateAssets,
  unwrap,
} from "../../packages/artifacts/dist/index.js";
import { crc32 } from "../../packages/types/dist/common.js";
import { readZip, writeZip } from "../../packages/artifacts/dist/zip.js";
import { staticNodes } from "../../packages/artifacts/dist/html.js";
import {
  retainedRecoveries,
  validateRecovery,
} from "../../apps/studio/dist/recovery.js";

const registry = JSON.parse(readFileSync("spec/registry.json", "utf8"));
const limits = registry.limits;
const input = (text) => ({ text, profile: "tinta", uri: "tinta:boundary" });
const span = {
  uri: "tinta:boundary",
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
};
const { zipSync, zlibSync } = createRequire(
  new URL("../../packages/artifacts/package.json", import.meta.url),
)("fflate");

function chunk(name, data) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(name), 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, -4)));
  return bytes;
}

function png(width = 1, height = 1, paddedBytes, marker = 0) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 1;
  // One-bit grayscale keeps even the pixel-ceiling fixture inexpensive.
  const scanlines = new Uint8Array((Math.ceil(width / 8) + 1) * height);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(scanlines)),
  ];
  const baseBytes = parts.reduce((sum, part) => sum + part.length, 0) + 12;
  const padding = new Uint8Array(
    paddedBytes ? paddedBytes - baseBytes - 12 : 1,
  );
  padding[0] = marker;
  parts.push(chunk("teSt", padding), chunk("IEND", new Uint8Array()));
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function expectLimit(result, name) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "E_LIMIT",
        details: expect.objectContaining({ limitName: name }),
      }),
    ]),
  );
}

test("sourceBytes accepts exactly the UTF-8 ceiling and rejects one extra byte", () => {
  const block = "😀".repeat(8000) + "\n";
  const contentBytes = limits.sourceBytes - 9;
  let content = block.repeat(
    Math.floor(contentBytes / Buffer.byteLength(block)),
  );
  content += " ".repeat(contentBytes - Buffer.byteLength(content));
  const source = "<!--\n" + content + "\n-->";
  expect(parse(input(source)).ok).toBe(true);
  expectLimit(parse(input(source + "\n")), "sourceBytes");
});

test("astNodes counter accepts its ceiling and charges the next node before acceptance", () => {
  const source = new Source(input("x"));
  source.charge("astNodes", 0, limits.astNodes);
  try {
    source.charge("astNodes", 0);
    expect.unreachable("An additional AST node must be rejected");
  } catch (error) {
    expect(error.diagnostic.details).toEqual({
      limitName: "astNodes",
      observed: limits.astNodes + 1,
      maximum: limits.astNodes,
    });
  }
});

for (const [phase, name] of [
  ["bind", "compileOperations"],
  ["evaluate", "evaluationOperations"],
]) {
  test(`${name} shares the exact counter ceiling across consecutive charges`, () => {
    const budget = new Budget(span, phase);
    budget.charge(span, limits[name] - 1);
    budget.charge();
    expect(budget.used).toBe(limits[name]);
    try {
      budget.charge();
      expect.unreachable("An additional operation must be rejected");
    } catch (error) {
      expect(error.diagnostic.details).toEqual({
        limitName: name,
        observed: limits[name] + 1,
        maximum: limits[name],
      });
    }
  });
}

test("histogram bins test the minimum, maximum and omitted default separately", () => {
  const data = "@data d\nx:number\n0\n1\n@end\n";
  const histogram = (bins) =>
    compile(
      input(
        data +
          `@chart histogram d (x:"x"${bins === undefined ? "" : `, bins:${bins}`})`,
      ),
    );
  for (const bins of [2, 30, undefined]) {
    const session = unwrap(createSession(unwrap(histogram(bins))));
    expect(session.getRevision().nodes[0].chart.bins).toHaveLength(bins ?? 8);
    session.destroy();
  }
  for (const bins of [1, 31]) {
    const result = histogram(bins);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("E_PROPERTY_VALUE");
  }
});

test("importBytes accepts valid CSV and JSON exactly at the byte ceiling", () => {
  const bytes = (source) => new TextEncoder().encode(source);
  const json = '[{"x":1}]';
  // Large Unicode headers normalize to short identifiers. This reaches the
  // import byte boundary without violating the generated source byte ceiling.
  const available = limits.importBytes - 63;
  const headers = Array.from({ length: 64 }, (_, index) => {
    const size = Math.floor(available / 64) + (index < available % 64 ? 1 : 0);
    const prefix = String(index);
    const remaining = size - prefix.length;
    return (
      prefix +
      "é".repeat(Math.floor(remaining / 2)) +
      (remaining % 2 ? "x" : "")
    );
  });
  const csv = headers.join(",");
  const fixtures = [
    [importJson, " ".repeat(limits.importBytes - json.length) + json],
    [importCsv, csv],
  ];
  for (const [importer, source] of fixtures) {
    expect(bytes(source)).toHaveLength(limits.importBytes);
    expect(importer(bytes(source), { name: "records" }).ok).toBe(true);
    expectLimit(
      importer(bytes(source + " "), { name: "records" }),
      "importBytes",
    );
  }
});

test("assetBytes validates a real padded PNG at the ceiling and rejects one extra byte", () => {
  expect(createAsset(png(1, 1, limits.assetBytes)).ok).toBe(true);
  const over = createAsset(png(1, 1, limits.assetBytes + 1));
  expect(over.ok).toBe(false);
  expect(over.diagnostics[0].code).toBe("E_LIMIT");
}, 30000);

test("imagePixels accepts a complete raster at the pixel ceiling and rejects its next pixel", () => {
  expect(createAsset(png(limits.imagePixels, 1)).ok).toBe(true);
  const over = createAsset(png(limits.imagePixels + 1, 1));
  expect(over.ok).toBe(false);
  expect(over.diagnostics[0].code).toBe("E_LIMIT");
});

test("assetCount counts unique hashes while preserving duplicate source aliases", () => {
  const assets = new Map();
  for (let index = 0; index < limits.assetCount; index++) {
    assets.set(
      `image-${index}.png`,
      unwrap(createAsset(png(1, 1, undefined, index))),
    );
  }
  assets.set("alias.png", assets.get("image-0.png"));
  expect(validateAssets(assets).size).toBe(limits.assetCount + 1);
  assets.set("extra.png", unwrap(createAsset(png(1, 1, undefined, 100))));
  expect(() => validateAssets(assets)).toThrow("Asset store limit exceeded");
});

test("totalAssetBytes accepts the exact unique byte total and rejects one more", () => {
  const assets = new Map([
    ["first.png", unwrap(createAsset(png(1, 1, limits.assetBytes, 1)))],
    ["second.png", unwrap(createAsset(png(1, 1, limits.assetBytes, 2)))],
    [
      "third.png",
      unwrap(
        createAsset(
          png(1, 1, limits.totalAssetBytes - 2 * limits.assetBytes, 3),
        ),
      ),
    ],
  ]);
  expect(validateAssets(assets).size).toBe(3);
  assets.set(
    "third.png",
    unwrap(
      createAsset(
        png(1, 1, limits.totalAssetBytes - 2 * limits.assetBytes + 1, 3),
      ),
    ),
  );
  expect(() => validateAssets(assets)).toThrow("Asset store limit exceeded");
}, 30000);

function archiveEntries(assetLengths) {
  return new Map([
    ["manifest.json", new Uint8Array()],
    ["document.tinta", new Uint8Array()],
    ...assetLengths.map((length, index) => [
      `assets/${index.toString(16).padStart(64, "0")}.png`,
      new Uint8Array(length),
    ]),
  ]);
}

test("bundleEntries reads exactly 102 directory entries and rejects entry 103", () => {
  expect(readZip(writeZip(archiveEntries(Array(100).fill(0)))).size).toBe(102);
  expect(() => readZip(writeZip(archiveEntries(Array(101).fill(0))))).toThrow(
    "ZIP entry limit exceeded",
  );
});

test("bundleExpandedBytes bounds actual inflation at exactly the total ceiling", () => {
  const at = archiveEntries(Array(3).fill(limits.assetBytes));
  expect(
    [...readZip(zipSync(Object.fromEntries(at))).values()].reduce(
      (sum, data) => sum + data.length,
      0,
    ),
  ).toBe(limits.bundleExpandedBytes);
  const over = archiveEntries([...Array(3).fill(limits.assetBytes), 1]);
  expect(() => readZip(zipSync(Object.fromEntries(over)))).toThrow(
    "Expanded bundle limit exceeded",
  );
}, 30000);

test("bundleCompressedBytes reads a valid stored archive exactly at its byte ceiling", () => {
  const empty = archiveEntries([0, 0, 0]);
  const overhead = writeZip(empty).length;
  const sizes = [
    limits.assetBytes,
    limits.assetBytes,
    limits.assetBytes - overhead,
  ];
  const archive = writeZip(archiveEntries(sizes));
  expect(archive).toHaveLength(limits.bundleCompressedBytes);
  expect(readZip(archive).size).toBe(5);
  const over = new Uint8Array(archive.length + 1);
  over.set(archive);
  expect(() => readZip(over)).toThrow("Compressed bundle limit exceeded");
}, 30000);

test("htmlBytes charges escaped output exactly at the ceiling across siblings", () => {
  const budget = { bytes: limits.htmlBytes - 5 };
  expect(staticNodes([{ kind: "text", value: "&" }], new Map(), budget)).toBe(
    "&amp;",
  );
  expect(budget.bytes).toBe(limits.htmlBytes);
  expect(() =>
    staticNodes([{ kind: "text", value: "x" }], new Map(), budget),
  ).toThrow("HTML byte limit");
});

test("recoveryTotalBytes evicts the oldest inactive entry only after the ceiling", () => {
  const active = {
    id: "active",
    edited: 10,
    source: "x",
    filename: "draft.tinta",
    profile: "tinta",
    assets: [],
  };
  const first = unwrap(createAsset(png(1, 1, limits.assetBytes, 1)));
  const second = unwrap(createAsset(png(1, 1, limits.assetBytes, 2)));
  const third = unwrap(createAsset(png(1, 1, limits.assetBytes - 3, 3)));
  const previous = [
    validateRecovery({
      ...active,
      id: "oldest",
      edited: 0,
      assets: [
        ["first.png", first],
        ["second.png", second],
      ],
    }),
    validateRecovery({
      ...active,
      id: "recent",
      edited: 1,
      assets: [["third.png", third]],
    }),
  ];
  expect(retainedRecoveries(previous, active)).toHaveLength(3);
  expect(retainedRecoveries(previous, { ...active, source: "xx" })).toEqual([
    { ...active, source: "xx" },
    previous[1],
  ]);
}, 30000);

test("sourceLineUnits rejects precisely the first excess UTF-16 unit", () => {
  expect(parse(input("x".repeat(limits.sourceLineUnits))).ok).toBe(true);
  expectLimit(
    parse(input("x".repeat(limits.sourceLineUnits + 1))),
    "sourceLineUnits",
  );
});

test("textValueUnits guard rejects its next unit independently of the line ceiling", () => {
  const source = new Source(input("x"));
  source.limit("textValueUnits", limits.textValueUnits, 0);
  try {
    source.limit("textValueUnits", limits.textValueUnits + 1, 0);
    expect.unreachable("An additional text unit must be rejected");
  } catch (error) {
    expect(error.diagnostic.details).toEqual({
      limitName: "textValueUnits",
      observed: limits.textValueUnits + 1,
      maximum: limits.textValueUnits,
    });
  }
});

test("chartMarks guard applies independently of row and series ceilings", () => {
  const budget = new Budget(span, "evaluate");
  budget.limit("chartMarks", limits.chartMarks);
  try {
    budget.limit("chartMarks", limits.chartMarks + 1);
    expect.unreachable("An additional mark must be rejected");
  } catch (error) {
    expect(error.diagnostic.details).toEqual({
      limitName: "chartMarks",
      observed: limits.chartMarks + 1,
      maximum: limits.chartMarks,
    });
  }
});

test("sliderFractionalDigits accepts six decimals and rejects seven", () => {
  expect(
    compile(input("@slider n = 0 (min:0,max:0.000001,step:0.000001)")).ok,
  ).toBe(true);
  const result = compile(
    input("@slider n = 0 (min:0,max:0.0000001,step:0.0000001)"),
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0].code).toBe("E_STATE_DOMAIN");
});

test("labelCodePoints and choiceOptionCodePoints count astral characters as one", () => {
  for (const [name, make] of [
    ["labelCodePoints", (value) => `@toggle n = true (label:"${value}")`],
    [
      "choiceOptionCodePoints",
      (value) => `@choice n = "${value}" (options:["${value}"])`,
    ],
  ]) {
    expect(compile(input(make("😀".repeat(limits[name])))).ok).toBe(true);
    expectLimit(compile(input(make("😀".repeat(limits[name] + 1)))), name);
  }
});

test("documentChartMarks accepts 32000 and rejects exactly mark 32001 without committing", async () => {
  const { performanceCorpus } =
    await import("../../scripts/performance-corpus.mjs");
  const source = performanceCorpus().find(
    (item) => item.name === "marks",
  ).source;
  const program = unwrap(
    compile(
      input(
        "@toggle extra = false\n" +
          source +
          '\n@data single\nx:number\n1\n@end\n@when extra\n@chart scatter single (x:"x",y:"x")\n@end',
      ),
    ),
  );
  const session = unwrap(createSession(program));
  try {
    const before = session.getRevision();
    const result = session.setControl("extra", true);
    expectLimit(result, "documentChartMarks");
    expect(result.diagnostics[0].details.observed).toBe(32001);
    expect(session.getRevision()).toBe(before);
  } finally {
    session.destroy();
  }
});
