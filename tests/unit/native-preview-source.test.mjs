import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSource, editSource } from "../../apps/vscode/dist/source.js";
import { readOpenedSource } from "../../packages/local-files/dist/index.js";
import { preparePreview } from "../../packages/language-service/dist/index.js";
import { encodeUtf8, hash } from "../../packages/types/dist/common.js";

const identity = {
  uri: "file:///document.tinta",
  documentInstance: "a".repeat(32),
  editorVersion: 1,
  sourceRevision: 0,
};
const acquire = (text, editor = text.replace(/^\uFEFF/, "")) =>
  acquireSource(encodeUtf8(text), editor, identity);

describe("verified native preview source", () => {
  it("preserves BOM, Unicode and CRLF across observed edits", () => {
    const source = acquire("\uFEFF# 😀\r\nHello\r\n");
    const edited = editSource(source, 2, "# 😀\r\nWorld\r\n", [
      { rangeOffset: 6, rangeLength: 5, text: "World" },
    ]);
    expect(edited.text).toBe("\uFEFF# 😀\r\nWorld\r\n");
    expect(edited.identity.sourceSha256).toBe(hash(encodeUtf8(edited.text)));
    expect(edited.identity.sourceRevision).toBe(1);
    const undone = editSource(edited, 3, source.editorText, [
      { rangeOffset: 6, rangeLength: 5, text: "Hello" },
    ]);
    expect(undone.text).toBe(source.text);
  });

  it("maps unchanged normalized files but requires conversion before edits", () => {
    for (const original of ["A\rB", "A\r\nB\nC"]) {
      const editor = original.replace(/\r\n?/g, "\n");
      const source = acquire(original, editor);
      expect(source.text).toBe(original);
      expect(source.conversionRequired).toBe(true);
      expect(() =>
        editSource(source, 2, editor + "D", [
          { rangeOffset: editor.length, rangeLength: 0, text: "D" },
        ]),
      ).toThrow("separate");
    }
  });

  it("rejects invalid bytes, oversize sources, gaps, overlap and split scalars", () => {
    expect(() =>
      acquireSource(Uint8Array.of(0xc3, 0x28), "�(", identity),
    ).toThrow();
    expect(acquire("�").text).toBe("�");
    expect(() => acquire("a".repeat(2097153))).toThrow("limit");
    expect(() => acquire("A\nB", "A")).toThrow("Unmapped");
    expect(() => acquire("A", "B")).toThrow("Unmapped");
    const source = acquire("A😀\r\nB");
    expect(() => editSource(source, 3, source.editorText, [])).toThrow("gap");
    for (const changes of [
      [{ rangeOffset: 2, rangeLength: 0, text: "X" }],
      [{ rangeOffset: 4, rangeLength: 0, text: "X" }],
      [{ rangeOffset: -1, rangeLength: 0, text: "X" }],
      [{ rangeOffset: 0, rangeLength: -1, text: "X" }],
      [
        { rangeOffset: 1, rangeLength: 2, text: "X" },
        { rangeOffset: 0, rangeLength: 2, text: "Y" },
      ],
      [{ rangeOffset: 0, rangeLength: 0, text: "\uD800" }],
    ])
      expect(() => editSource(source, 2, "Other", changes)).toThrow();
  });

  it("compiles the exact verified revision and rejects initial evaluation errors", () => {
    for (const text of ["# Valid", "\uFEFF# 😀\r\n"]) {
      const source = acquire(text);
      const result = preparePreview(source.identity, source.text);
      expect(result.identity).toEqual(source.identity);
      expect(result.result.ok).toBe(true);
      expect(result.result.value.source).toBe(text);
      expect(result.result.value.sourceSha256).toBe(
        source.identity.sourceSha256,
      );
      expect(() => preparePreview(source.identity, text + "changed")).toThrow(
        "identity",
      );
    }
    for (const text of ["@calc result = missing", "@calc result = 1 / 0"]) {
      const source = acquire(text);
      expect(preparePreview(source.identity, text).result.ok).toBe(false);
    }
  });

  it("reads only a bounded exact regular file without following a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinta-preview-source-"));
    try {
      const path = join(root, "document 😀.tinta");
      await writeFile(path, "\uFEFF# Source\r\n");
      expect(await readOpenedSource(path)).toEqual(
        encodeUtf8("\uFEFF# Source\r\n"),
      );
      await symlink(path, join(root, "link.tinta"));
      await expect(
        readOpenedSource(join(root, "link.tinta")),
      ).rejects.toMatchObject({ code: "E_IO" });
      await mkdir(join(root, "directory"));
      await expect(
        readOpenedSource(join(root, "directory")),
      ).rejects.toMatchObject({ code: "E_IO" });
      await writeFile(path, new Uint8Array(2097153));
      await expect(readOpenedSource(path)).rejects.toMatchObject({
        code: "E_LIMIT",
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
