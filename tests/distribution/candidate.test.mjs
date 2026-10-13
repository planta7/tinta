import { describe, expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseConfig } from "../../scripts/release-contract.mjs";
import { checkInventory } from "../../scripts/release-candidate.mjs";
import { digest } from "../../scripts/distribution-archive.mjs";

const config = loadReleaseConfig();
describe("public supplied-archive checker", () => {
  it("checks the actual local payloads without upgrading them to a clean candidate", () => {
    const original = JSON.parse(
      readFileSync("build/distribution/inventory.json"),
    );
    const checked = checkInventory("build/distribution", config);
    expect(checked).toEqual(original);
    if (original.source.dirty) {
      expect(() =>
        checkInventory("build/distribution", config, { clean: true }),
      ).toThrow(/Dirty/);
    }
  });
  it.each([
    "archive",
    "member",
    "mixed-version",
    "missing-target",
    "duplicate-target",
    "lock",
    "configuration",
    "path",
    "release-plan-digest",
    "release-plan-source",
    "release-plan-version",
    "release-plan-notes",
  ])("rejects tampered %s", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "tinta-candidate-fixture-"));
    try {
      cpSync("build/distribution", root, { recursive: true });
      const path = join(root, "inventory.json");
      const inventory = JSON.parse(readFileSync(path));
      if (kind === "archive")
        writeFileSync(join(root, inventory.targets[0].archive), "corrupt");
      if (kind === "member")
        inventory.targets[0].files[0].sha256 = "0".repeat(64);
      if (kind === "mixed-version") inventory.versions.implementation = "9.9.9";
      if (kind === "missing-target") inventory.targets.pop();
      if (kind === "duplicate-target")
        inventory.targets[1] = inventory.targets[0];
      if (kind === "lock") inventory.lockSha256 = "0".repeat(64);
      if (kind === "configuration") inventory.configSha256 = "0".repeat(64);
      if (kind === "path") inventory.targets[0].archive = "../unexpected.tgz";
      if (kind.startsWith("release-plan-")) {
        const plan = {
          sourceSha: inventory.source.commit,
          implementation: config.versions.implementation,
          extension: config.versions.extension,
          notes: "Fixture release notes",
        };
        if (kind === "release-plan-source") plan.sourceSha = "0".repeat(40);
        if (kind === "release-plan-version") plan.extension = "999.0.0";
        if (kind === "release-plan-notes") plan.notes = "";
        const bytes = Buffer.from(JSON.stringify(plan));
        writeFileSync(join(root, "release-plan.json"), bytes);
        inventory.releasePlan = {
          path: "release-plan.json",
          sha256:
            kind === "release-plan-digest" ? "0".repeat(64) : digest(bytes),
        };
      }
      writeFileSync(path, JSON.stringify(inventory));
      expect(() => checkInventory(root, config)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
