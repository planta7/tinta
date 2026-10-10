import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function captureCandidate() {
  const output = execFileSync(
    "git",
    ["ls-files", "-c", "-o", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  const deleted = new Set(
    execFileSync("git", ["ls-files", "--deleted", "-z"], {
      encoding: "utf8",
    }).split("\0"),
  );
  const paths = [...new Set(output.split("\0").filter(Boolean))]
    .filter((path) => !deleted.has(path))
    .sort();
  const hash = createHash("sha256");
  const files = paths.map((path) => {
    const roots = [
      "apps",
      "packages",
      "tests",
      "scripts",
      "toolchain",
      "patches",
      "third_party",
      "spec",
      "schemas",
      "contracts",
      "conformance",
      "docs",
      "architecture",
      "examples",
      "decisions",
      ".github",
    ];
    const rootFiles = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "DECISIONS.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      ".gitignore",
      ".prettierignore",
      ".prettierrc.json",
      ".npmrc",
      ".nvmrc",
      ".node-version",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "tsconfig.base.json",
      "eslint.config.js",
      "vitest.config.js",
      "playwright.config.js",
    ];
    if (!roots.includes(path.split("/")[0]) && !rootFiles.includes(path)) {
      throw new Error(`Unreviewed path in candidate: ${path}`);
    }
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    hash.update(path + "\0" + sha256 + "\n");
    return { path, bytes: bytes.length, sha256 };
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
      .length > 0;
  return { commit, dirty, sourceSha256: hash.digest("hex"), files };
}
