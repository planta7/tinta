import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("source inventory retains dirty status while omitting deliberately deleted files", () => {
  const directory = mkdtempSync(join(tmpdir(), "tinta-source-inventory-"));
  try {
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: directory },
      );
    git("init", "--quiet");
    writeFileSync(join(directory, "README.md"), "# Original\n");
    git("add", "README.md");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    );
    unlinkSync(join(directory, "README.md"));
    writeFileSync(join(directory, "LICENSE"), "Synthetic license fixture\n");
    const moduleUrl = pathToFileURL(resolve("scripts/candidate.mjs")).href;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { captureCandidate } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(captureCandidate()));`,
        ],
        { cwd: directory, encoding: "utf8" },
      ),
    );
    expect(result.dirty).toBe(true);
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.files.map((file) => file.path)).toEqual(["LICENSE"]);
    expect(result.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
