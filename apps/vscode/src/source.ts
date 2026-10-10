import { decodeUtf8, encodeUtf8, hash, limits } from "@tinta/types/common";
import type { SourceIdentity } from "@tinta/types/editor";

interface Line {
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

function lines(text: string, start: number): Line[] {
  const result: Line[] = [];
  let end = start;
  while (end < text.length) {
    if (text[end] !== "\r" && text[end] !== "\n") {
      end++;
      continue;
    }
    const next = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1);
    result.push({ start, end, next });
    start = next;
    end = next;
  }
  result.push({ start, end, next: end });
  return result;
}

export interface NativeSource {
  readonly identity: SourceIdentity;
  readonly text: string;
  readonly editorText: string;
  readonly conversionRequired: boolean;
  readonly map: readonly { readonly source: Line; readonly editor: Line }[];
}

export function acquireSource(
  bytes: Uint8Array,
  editorText: string,
  identity: Omit<SourceIdentity, "profile" | "sourceSha256">,
): NativeSource {
  if (bytes.length > limits.sourceBytes)
    throw new Error("Source byte limit exceeded.");
  const text = decodeUtf8(bytes);
  const sourceLines = lines(text, text.startsWith("\uFEFF") ? 1 : 0);
  const editorLines = lines(editorText, 0);
  if (sourceLines.length !== editorLines.length)
    throw new Error("Unmapped source.");
  const map = sourceLines.map((source, index) => {
    const editor = editorLines[index]!;
    if (
      text.slice(source.start, source.end) !==
      editorText.slice(editor.start, editor.end)
    )
      throw new Error("Unmapped source.");
    return { source, editor };
  });
  const endings = new Set(
    sourceLines
      .filter((line) => line.next !== line.end)
      .map((line) => text.slice(line.end, line.next)),
  );
  return {
    identity: { ...identity, profile: "tinta", sourceSha256: hash(bytes) },
    text,
    editorText,
    map,
    conversionRequired: endings.has("\r") || endings.size > 1,
  };
}

export function editSource(
  before: NativeSource,
  version: number,
  editorText: string,
  changes: readonly {
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[],
): NativeSource {
  if (before.conversionRequired)
    throw new Error(
      "Create a separate UTF-8/LF copy before previewing edited source.",
    );
  if (version !== before.identity.editorVersion + 1)
    throw new Error("Source version gap.");
  const endpoint = (offset: number): number => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid edit.");
    for (const pair of before.map)
      if (offset >= pair.editor.start && offset <= pair.editor.end)
        return pair.source.start + offset - pair.editor.start;
    throw new Error("Edit inside a line ending.");
  };
  let text = before.text;
  let last = before.editorText.length + 1;
  for (const change of [...changes].sort(
    (left, right) => right.rangeOffset - left.rangeOffset,
  )) {
    const end = change.rangeOffset + change.rangeLength;
    if (change.rangeLength < 0 || end > last)
      throw new Error("Overlapping edits.");
    const from = endpoint(change.rangeOffset);
    const to = endpoint(end);
    encodeUtf8(text.slice(0, from));
    encodeUtf8(text.slice(to));
    text = text.slice(0, from) + change.text + text.slice(to);
    last = change.rangeOffset;
  }
  return acquireSource(encodeUtf8(text), editorText, {
    ...before.identity,
    editorVersion: version,
    sourceRevision: before.identity.sourceRevision + 1,
  });
}
