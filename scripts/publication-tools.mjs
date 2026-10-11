import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./publication-journal.mjs";

export function toolTree(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Unexpected publishing tool symlink");
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(...toolTree(join(directory, entry.name), path + "/"));
    } else {
      assert.ok(entry.isFile(), "Unexpected publishing tool entry");
      files.push([path, hash(readFileSync(join(directory, entry.name)))]);
    }
  }
  return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function verifyPublishingTool(directory, policy, lock) {
  assert.equal(lock.format, "tinta-bundled-tool-lock-1");
  assert.equal(lock.version, policy.version);
  assert.equal(lock.integrity, policy.integrity);
  assert.equal(lock.archive, policy.url);
  const root = lock.packages.find((item) => item.path === "package.json");
  assert.ok(root, "Missing bundled tool root");
  const manifest = JSON.parse(readFileSync(join(directory, "package.json")));
  assert.equal(manifest.name, "npm");
  assert.equal(manifest.version, policy.version);
  const tree = toolTree(directory)
    .map(([path, digest]) => `${path}\0${digest}\n`)
    .join("");
  assert.equal(
    hash(tree),
    root.treeSha256,
    "Publishing tool tree differs from locked bytes",
  );
}
