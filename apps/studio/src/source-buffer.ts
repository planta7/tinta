/** Map CodeMirror's LF positions to the original, mixed-ending UTF-16 source. */
export function sourceOffset(source: string, normalizedOffset: number): number {
  let normalized = 0;
  let original = 0;
  while (original < source.length && normalized < normalizedOffset) {
    if (source[original] === "\r" && source[original + 1] === "\n") original++;
    original++;
    normalized++;
  }
  return original;
}

export function editorOffset(source: string, originalOffset: number): number {
  return source.slice(0, originalOffset).replace(/\r\n|\r/g, "\n").length;
}

export function normalizedSource(source: string): string {
  return source.replace(/\r\n|\r/g, "\n");
}
