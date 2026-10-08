import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const requested = process.argv.slice(2);
if (requested.length && requested.join(" ") !== "--suite infrastructure") {
  console.error("NOT_IMPLEMENTED: supported aggregate suite is infrastructure");
  process.exit(1);
}
const commands = [
  ["python3", "scripts/check_spec.py"],
  ["python3", "-m", "unittest", "discover", "-s", "scripts/tests", "-v"],
  ...[
    "format:check",
    "lint",
    "typecheck",
    "check:dependencies",
    "check:architecture",
    "test:unit",
    "build",
    "test:browser:infrastructure",
    "check:licenses",
  ].map((s) => ["pnpm", s]),
  ["pnpm", "audit", "--audit-level=high"],
];
const results = [];
for (const command of commands) {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  results.push({
    command,
    exitCode: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/verify.json",
  JSON.stringify({ suite: "infrastructure", results }, null, 2) + "\n",
);
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
