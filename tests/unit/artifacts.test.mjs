import { propertyRuns } from "../support/properties.mjs";
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  createAsset,
  createStateSnapshot,
  validateStateSnapshot,
  exportHtml,
  packSource,
  openBundle,
  strictJson,
  encodeUtf8,
  decodeUtf8,
  hash,
  normalizeAssetPath,
  unwrap,
} from "../../packages/artifacts/dist/index.js";
import { readZip, writeZip } from "../../packages/artifacts/dist/zip.js";
import { crc32 } from "../../packages/types/dist/common.js";
import { imageDestinationEdits } from "../../packages/syntax/dist/index.js";
import fc from "fast-check";

const program = (text, profile = "tinta") =>
  unwrap(
    compile({
      text,
      profile,
      uri: "file:///private/sensitive/source.tinta",
    }),
  );
const imageBytes = readFileSync(
  "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
);
const image = unwrap(createAsset(imageBytes));
const source =
  '@toggle visible = false (label: "Show secret")\n' +
  "\nPublic.\n\n@when visible\n\nSECRET DATA\n\n![hidden](hidden.png)\n\n@end" +
  "\n";

describe("strict artifact inputs", () => {
  test.each([
    '{"a":1,"a":2}',
    '{"a":{"b":1,"\\u0062":2}}',
    '{"x":1e400}',
    '{"x":1,}',
    "[1,]",
    "null null",
    '"unterminated',
    '{"x":01}',
  ])("rejects ambiguous JSON %s", (value) =>
    expect(() => strictJson(value)).toThrow(),
  );
  test("bounded JSON preserves prototype-looking keys as data", () => {
    expect(Object.getPrototypeOf(strictJson('{"__proto__":true}'))).toBeNull();
    expect(() => strictJson("[".repeat(258) + "]".repeat(258))).toThrow();
    expect(() => strictJson('"1234"', 3)).toThrow();
  });
  test.each([
    "../x.png",
    "a/../x.png",
    "/x.png",
    "C:/x.png",
    "\\server\\x.png",
    "a//x.png",
    "a%2fb/../x.png",
    "a%00.png",
    "%ff.png",
    "x.png?x",
    "x.png#x",
    "https://x.test/x.png",
    "data:image/png;base64,x",
    "//host/x",
  ])("rejects path %s", (path) =>
    expect(() => normalizeAssetPath(path)).toThrow(),
  );
  test("normalizes exactly once", () => {
    expect(normalizeAssetPath("./my%20image.png")).toBe("my image.png");
    expect(normalizeAssetPath("a%2520.png")).toBe("a%20.png");
  });
  test("validates raster bytes, copies capabilities and ignores suffixes", () => {
    expect(image.mime).toBe("image/png");
    expect(image.path).toContain(hash(imageBytes));
    expect(image.bytes).not.toBe(imageBytes);
    for (const bytes of [
      encodeUtf8("<svg></svg>"),
      encodeUtf8("GIF89a"),
      imageBytes.subarray(0, 20),
      Uint8Array.of(255, 216, 255, 217),
    ])
      expect(createAsset(bytes).ok).toBe(false);
    const corrupt = Uint8Array.from(imageBytes);
    corrupt[40] ^= 1;
    expect(createAsset(corrupt).ok).toBe(false);
  });
  test("rejects animation and excessive pixel dimensions with valid CRC", () => {
    const large = Uint8Array.from(imageBytes),
      view = new DataView(large.buffer);
    view.setUint32(16, 20000001);
    view.setUint32(20, 1);
    view.setUint32(29, crc32(large.subarray(12, 29)));
    expect(createAsset(large).diagnostics[0].code).toBe("E_LIMIT");
  });
});
describe("snapshots", () => {
  const compiled = program(
    "@slider amount = 2 (min: 0, max: 10, step: 1)\n@toggle active = false\n",
  );
  test("round trips a complete selected baseline and resets there", () => {
    const session = unwrap(createSession(compiled));
    unwrap(session.setControl("amount", 8));
    const snapshot = createStateSnapshot(session);
    expect(Object.keys(snapshot.controls)).toEqual(["active", "amount"]);
    const restored = unwrap(
      createSession(compiled, {
        baseline: unwrap(
          validateStateSnapshot(compiled, JSON.stringify(snapshot)),
        ),
      }),
    );
    unwrap(restored.setControl("amount", 3));
    unwrap(restored.reset());
    expect(restored.getRevision().state.amount).toBe(8);
    session.destroy();
    restored.destroy();
  });
  test.each([
    { amount: 2 },
    { amount: 2, active: false, unknown: 1 },
    { amount: 2.5, active: false },
    { amount: "2", active: false },
  ])("rejects incomplete or invalid controls", (controls) => {
    expect(
      validateStateSnapshot(compiled, {
        kind: "tinta-state",
        formatVersion: "1.0",
        sourceSha256: compiled.sourceSha256,
        controls,
      }).ok,
    ).toBe(false);
  });
  test("rejects hash, extra metadata and duplicate keys", () => {
    const session = unwrap(createSession(compiled)),
      snapshot = createStateSnapshot(session);
    expect(
      validateStateSnapshot(compiled, {
        ...snapshot,
        sourceSha256: "0".repeat(64),
      }).ok,
    ).toBe(false);
    expect(validateStateSnapshot(compiled, { ...snapshot, time: 0 }).ok).toBe(
      false,
    );
    expect(
      validateStateSnapshot(
        compiled,
        JSON.stringify(snapshot).replace('"amount":2', '"amount":2,"amount":3'),
      ).ok,
    ).toBe(false);
    session.destroy();
  });
});
describe("source bundles", () => {
  test("canonical packing changes only image destinations and preserves BOM/CRLF", async () => {
    const text =
      "﻿# Sample\r\n" +
      "\r\n" +
      '![description](<my%20image.png> "Title")\r\n' +
      "\r\n`![literal](my%20image.png)`\r\n";
    const result = unwrap(
      await packSource(program(text), new Map([["my image.png", image]])),
    );
    const repeat = unwrap(
      await packSource(program(text), new Map([["my image.png", image]])),
    );
    expect(result.bytes).toEqual(repeat.bytes);
    const opened = unwrap(await openBundle(result.bytes));
    expect(decodeUtf8(opened.source.bytes)).toBe(
      text.replace("<my%20image.png>", `<${image.path}>`),
    );
    expect(opened.assets.get(image.path).bytes).toEqual(
      Uint8Array.from(imageBytes),
    );
    expect(text).toContain("my%20image.png");
  });
  test("reads the existing fixture ZIP", async () =>
    expect(
      (await openBundle(readFileSync("examples/local-image.tinta.zip"))).ok,
    ).toBe(true));
  test("finds actual image and reference destination tokens", () => {
    const text =
      '![x][picture]\n\n[picture]: <image.png> "caption"\n\n```\n![x](image.png)\n```\n';
    const edits = unwrap(
      imageDestinationEdits(
        { text, uri: "tinta:test", profile: "tinta" },
        new Map([["image.png", image.path]]),
      ),
    );
    expect(edits).toEqual([
      {
        start: text.indexOf("image.png"),
        end: text.indexOf("image.png") + 9,
        replacement: image.path,
      },
    ]);
  });
  test("rejects unknown paths, CRC corruption, trailing bytes, duplicate JSON and hash lies", async () => {
    const packed = unwrap(await packSource(program("# Valid\n"), new Map()));
    const entries = readZip(packed.bytes);
    const unknown = new Map(entries);
    unknown.set("../escape", Uint8Array.of(1));
    expect((await openBundle(writeZip(unknown))).ok).toBe(false);
    expect((await openBundle(Uint8Array.from([...packed.bytes, 0]))).ok).toBe(
      false,
    );
    const badCrc = packed.bytes.slice();
    badCrc[60] ^= 1;
    expect((await openBundle(badCrc)).ok).toBe(false);
    const duplicate = new Map(entries);
    duplicate.set(
      "manifest.json",
      encodeUtf8(
        decodeUtf8(entries.get("manifest.json")).replace(
          '"kind":',
          '"kind":"tinta-source-bundle","kind":',
        ),
      ),
    );
    expect((await openBundle(writeZip(duplicate))).ok).toBe(false);
    const mismatch = new Map(entries);
    mismatch.set("document.tinta", encodeUtf8("# Other\n"));
    expect((await openBundle(writeZip(mismatch))).ok).toBe(false);
  });
  test("bounded generated junk never returns an archive or throws", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 500 }), async (bytes) => {
        expect((await openBundle(bytes)).ok).toBe(false);
      }),
      { seed: 32019, numRuns: propertyRuns },
    );
  });
});
describe("HTML exports", () => {
  test("static omits hidden data/source/assets and does not need hidden images", async () => {
    const session = unwrap(createSession(program(source)));
    const result = unwrap(
      await exportHtml(session, new Map(), {
        format: "static",
        answers: "initial",
      }),
    );
    const html = decodeUtf8(result.bytes);
    expect(html).toContain("Public.");
    expect(html).not.toContain("SECRET DATA");
    expect(html).not.toContain("hidden.png");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("file:///");
    expect(html).toContain("script-src &#39;none&#39;");
    expect(
      (
        await exportHtml(session, new Map(), {
          format: "interactive",
          answers: "initial",
        })
      ).ok,
    ).toBe(false);
    unwrap(session.setControl("visible", true));
    expect(
      (
        await exportHtml(session, new Map(), {
          format: "static",
          answers: "current",
        })
      ).ok,
    ).toBe(false);
    session.destroy();
  });
  test(
    "interactive escapes payload terminators, rebases private paths " +
      "and includes complete content",
    async () => {
      const text =
        source +
        "\n```text\n</script><script>globalThis.compromised=true</script>\n```\n";
      const session = unwrap(createSession(program(text)));
      const output = unwrap(
        await exportHtml(session, new Map([["hidden.png", image]]), {
          format: "interactive",
          answers: "initial",
        }),
      );
      const html = decodeUtf8(output.bytes);
      expect(html).toContain("\\u003c/script\\u003e");
      expect(html).toContain("SECRET DATA");
      expect(html).not.toContain("file:///private/");
      expect(html).toContain("tinta:/document.tinta");
      expect(html).toContain("Hidden content is not private.");
      expect(html).not.toContain("unsafe-inline");
      expect((html.match(/<script/g) || []).length).toBe(2);
      session.destroy();
    },
  );
  test.each(["article", "report", "guide", "chart-atlas"])(
    "exports complete %s example both ways",
    async (name) => {
      const session = unwrap(
        createSession(program(readFileSync(`examples/${name}.tinta`, "utf8"))),
      );
      for (const format of ["static", "interactive"])
        expect(
          (await exportHtml(session, new Map(), { format, answers: "initial" }))
            .ok,
        ).toBe(true);
      expect((await packSource(session.program, new Map())).ok).toBe(true);
      session.destroy();
    },
  );
});

test("shared image references preserve ordinary links and original label/title syntax", async () => {
  const text =
    '![a *b*][r]\n\n[link][r]\n\n[r]: picture.png "Original title"\n';
  const result = unwrap(
    await packSource(program(text), new Map([["picture.png", image]])),
  );
  const opened = unwrap(await openBundle(result.bytes));
  expect(decodeUtf8(opened.source.bytes)).toBe(
    `![a *b*](${image.path} "Original title")\n\n[link][r]\n\n[r]: picture.png "Original title"\n`,
  );
  expect(text).toContain("![a *b*][r]");
});
