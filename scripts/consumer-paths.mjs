import path from "node:path";

/** Callers resolve symbolic links before applying this containment check. */
export function isInsideDirectory(root, target, paths = path) {
  const relative = paths.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  );
}
