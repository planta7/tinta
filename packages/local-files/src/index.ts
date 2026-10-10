import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { ArtifactFailure, limits } from "@tinta/types/common";

/** Exact host-selected open document only; no image-root or output authority. */
export async function readOpenedSource(path: string): Promise<Uint8Array> {
  const before = await lstat(path);
  const resolved = await realpath(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactFailure(
      "E_IO",
      "Source must be a regular file, not a link.",
    );
  if (before.size > limits.sourceBytes)
    throw new ArtifactFailure("E_LIMIT", "Source byte limit exceeded.");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    )
      throw new ArtifactFailure(
        "E_IO",
        "Source identity changed while opening.",
      );
    const bytes = new Uint8Array(limits.sourceBytes + 1);
    let length = 0;
    for (;;) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      length += result.bytesRead;
      if (length > limits.sourceBytes)
        throw new ArtifactFailure("E_LIMIT", "Source byte limit exceeded.");
      if (!result.bytesRead) break;
    }
    const after = await lstat(path);
    const descriptor = await handle.stat();
    for (const stat of [opened, after, descriptor]) {
      if (
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size !== length ||
        stat.mtimeMs !== before.mtimeMs ||
        stat.ctimeMs !== before.ctimeMs ||
        !stat.isFile() ||
        stat.isSymbolicLink()
      )
        throw new ArtifactFailure("E_IO", "Source changed while reading.");
    }
    if ((await realpath(path)) !== resolved)
      throw new ArtifactFailure("E_IO", "Source path changed while reading.");
    return bytes.slice(0, length);
  } finally {
    await handle.close();
  }
}
