import { runCommandSync } from "./commands.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionVersion } from "./vscode-package.mjs";

const desktop = process.env.TINTA_VSCODE_EXECUTABLE;
const cli = process.env.TINTA_VSCODE_CLI;
if (!desktop || !cli) {
  console.error(
    "Native checks require TINTA_VSCODE_EXECUTABLE and TINTA_VSCODE_CLI.",
  );
  process.exit(1);
}
// macOS Unix-domain socket paths must remain below the native length limit.
const temporary = process.platform === "darwin" ? "/tmp" : tmpdir();
const root = mkdtempSync(join(temporary, "tinta-suite-"));
const commands = [
  ["python3", "scripts/check_spec.py"],
  ["python3", "-m", "unittest", "discover", "-s", "scripts/tests", "-v"],
  ...[
    "format:check",
    "lint",
    "typecheck",
    "check:dependencies",
    "check:architecture",
    "check:licenses",
    "package:vscode",
    "test:unit",
    "test:vscode:unit",
    "test:vscode:browser",
  ].map((name) => ["pnpm", name]),
  ["pnpm", "test:conformance", "parsing"],
  ["pnpm", "test:conformance", "semantics"],
  ["node", "scripts/test-vscode-editing.mjs", desktop, join(root, "editing")],
  ...["--workflow", "--restricted", "--performance"].map((mode) => [
    "node",
    "scripts/test-vscode-installed.mjs",
    desktop,
    cli,
    `build/vscode/tinta-${extensionVersion}.vsix`,
    join(root, mode.slice(2)),
    mode,
  ]),
];
const results = [];
for (const command of commands) {
  const result = runCommandSync(command);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  results.push({
    command,
    exitCode: result.status,
    error: result.error?.message,
  });
  if (result.status !== 0) break;
}
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/vscode.json",
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      nativeResults: root,
      scope:
        "Current local platform only; unavailable platforms are not inferred.",
      mandatoryCommands: commands.length,
      results,
    },
    null,
    2,
  ) + "\n",
);
process.exitCode =
  results.length !== commands.length ||
  results.some((result) => result.exitCode !== 0)
    ? 1
    : 0;
