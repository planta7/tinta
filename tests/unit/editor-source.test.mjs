import { describe, expect, it } from "vitest";
import {
  sourceMap,
  sourcePosition,
  sourceEdit,
} from "../vscode/source-map.mjs";

const bytes = (text) => new TextEncoder().encode(text);

describe("native source identity mapping probe", () => {
  for (const ending of ["\n", "\r", "\r\n"]) {
    it(`maps original UTF-16 and BOM with ${JSON.stringify(ending)}`, () => {
      const original = `\uFEFFA😀${ending}B${ending}`;
      const model = sourceMap(bytes(original), "A😀\r\nB\r\n");
      expect(sourcePosition(model, 0)).toEqual({ line: 0, character: 0 });
      expect(sourcePosition(model, 1)).toEqual({ line: 0, character: 0 });
      expect(sourcePosition(model, 3)).toEqual({ line: 0, character: 2 });
      expect(sourcePosition(model, 4)).toEqual({ line: 0, character: 3 });
      expect(sourcePosition(model, 4 + ending.length)).toEqual({
        line: 1,
        character: 0,
      });
      expect(sourcePosition(model, original.length)).toEqual({
        line: 2,
        character: 0,
      });
    });
  }

  it("retains original segments and BOM through a versioned edit", () => {
    const model = sourceMap(bytes("\uFEFFA😀\r\nB\r\n"), "A😀\r\nB\r\n");
    const edited = sourceEdit(model, 4, {
      previousVersion: 4,
      nextVersion: 5,
      changes: [{ from: 5, to: 6, text: "C" }],
    });
    expect(edited).toEqual(bytes("\uFEFFA😀\r\nC\r\n"));
  });

  it("maps mixed endings without claiming an inverse at collapsed positions", () => {
    const model = sourceMap(bytes("A\rB\r\nC\n"), "A\r\nB\r\nC\r\n");
    expect(sourcePosition(model, 2)).toEqual({ line: 1, character: 0 });
    expect(sourcePosition(model, 3)).toEqual({ line: 1, character: 1 });
    expect(sourcePosition(model, 4)).toEqual({ line: 1, character: 1 });
    expect(sourcePosition(model, 5)).toEqual({ line: 2, character: 0 });
  });

  it("rejects invalid UTF-8 but permits an authored replacement character", () => {
    expect(() => sourceMap(Uint8Array.of(0xc3, 0x28), "�(")).toThrow();
    expect(sourceMap(bytes("�"), "�").text).toBe("�");
  });

  it("rejects mismatched buffers, stale edits, invalid ranges and scalar splits", () => {
    expect(() => sourceMap(bytes("A"), "B")).toThrow();
    const model = sourceMap(bytes("A😀\r\nB"), "A😀\r\nB");
    const event = {
      previousVersion: 1,
      nextVersion: 2,
      changes: [],
    };
    expect(() => sourceEdit(model, 2, event)).toThrow();

    for (const changes of [
      [{ from: 2, to: 2, text: "X" }],
      [{ from: 4, to: 4, text: "X" }],
      [{ from: -1, to: 0, text: "X" }],
      [{ from: 0, to: 1, text: "\uD800" }],
      [
        { from: 0, to: 2, text: "X" },
        { from: 1, to: 2, text: "Y" },
      ],
    ])
      expect(() => sourceEdit(model, 1, { ...event, changes })).toThrow();
  });
});
