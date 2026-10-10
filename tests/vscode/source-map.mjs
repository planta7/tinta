// Contract probe only. The portable service owns the eventual production adapter.
import { decodeUtf8, encodeUtf8 } from "../../packages/types/dist/utf8.js";

export function sourceMap(bytes, editorText) {
  const text = decodeUtf8(bytes);
  const bomUnits = text.startsWith("\uFEFF") ? 1 : 0;
  const sourceLines = lines(text, bomUnits);
  const editorLines = lines(editorText, 0);
  if (sourceLines.length !== editorLines.length)
    throw new Error("Unmapped source");
  const map = sourceLines.map((line, index) => {
    const editor = editorLines[index];
    if (
      text.slice(line.start, line.end) !==
      editorText.slice(editor.start, editor.end)
    )
      throw new Error("Unmapped source");
    return { source: line, editor };
  });
  return { text, editorText, bomUnits, map };
}

function lines(text, start) {
  const result = [];
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

export function sourcePosition(model, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > model.text.length)
    throw new Error("Invalid offset");
  for (let line = 0; line < model.map.length; line++) {
    const span = model.map[line].source;
    if (offset < span.next || line === model.map.length - 1)
      return {
        line,
        character: Math.max(0, Math.min(offset, span.end) - span.start),
      };
  }
  throw new Error("Unmapped source");
}

export function sourceEdit(model, previousVersion, event) {
  if (
    event.previousVersion !== previousVersion ||
    event.nextVersion !== previousVersion + 1
  )
    throw new Error("Stale version");
  function endpoint(offset) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > model.editorText.length
    )
      throw new Error("Invalid edit");
    for (const pair of model.map) {
      if (offset >= pair.editor.start && offset <= pair.editor.end)
        return pair.source.start + offset - pair.editor.start;
    }
    throw new Error("Edit inside a normalized line ending");
  }
  let text = model.text;
  let last = model.editorText.length + 1;
  for (const change of event.changes) {
    if (change.to > last || change.from > change.to)
      throw new Error("Overlapping edits");
    const from = endpoint(change.from);
    const to = endpoint(change.to);
    // Encoding both retained slices independently rejects surrogate splits.
    encodeUtf8(text.slice(0, from));
    encodeUtf8(text.slice(to));
    text = text.slice(0, from) + change.text + text.slice(to);
    last = change.from;
  }
  return encodeUtf8(text);
}
