import { runCommandSync } from "./commands.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const requested = process.argv.slice(2);
const suite = requested.length ? requested.join(" ") : "--suite infrastructure";

if (
  ![
    "--suite infrastructure",
    "--suite parsing",
    "--suite semantics",
    "--suite reading",
    "--suite charting",
    "--suite artifacts",
    "--suite editing",
  ].includes(suite)
) {
  console.error(
    "NOT_IMPLEMENTED: supported aggregate suites are infrastructure, " +
      "parsing, semantics, reading, charting, artifacts and editing",
  );
  process.exit(1);
}

const commands = [
  ["python3", "scripts/check_spec.py"],
  ["python3", "-m", "unittest", "discover", "-s", "scripts/tests", "-v"],
  ...([
    "--suite semantics",
    "--suite reading",
    "--suite charting",
    "--suite artifacts",
    "--suite editing",
  ].includes(suite)
    ? [["node", "scripts/program-schema.mjs", "--check"]]
    : []),
  ...[
    "format:check",
    "lint",
    "typecheck",
    "check:dependencies",
    "check:architecture",
    "build",
    "test:unit",
    "test:browser:infrastructure",
    "check:licenses",
  ].map((s) => [
    "pnpm",
    s,
    ...(s === "test:unit" && process.env.TINTA_PROPERTY_RUNS === "10000"
      ? ["--testTimeout=120000"]
      : []),
  ]),
  ...(suite === "--suite editing"
    ? [
        [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "--coverage",
          "--config",
          "scripts/studio-vitest.config.js",
        ],
        ["node", "scripts/studio-coverage.mjs"],
      ]
    : []),
  ...(["--suite artifacts", "--suite editing"].includes(suite)
    ? [
        ["node", "scripts/artifact-size.mjs"],
        [
          "node",
          "scripts/reader-coverage.mjs",
          "reports/verification/export-coverage.json",
        ],
      ]
    : []),
  ...([
    "--suite semantics",
    "--suite reading",
    "--suite charting",
    "--suite artifacts",
    "--suite editing",
  ].includes(suite)
    ? [
        ["pnpm", "test:conformance", "parsing"],
        ["pnpm", "test:conformance", "semantics"],
        ["node", "scripts/engine-size.mjs"],
        ...([
          "--suite reading",
          "--suite charting",
          "--suite artifacts",
          "--suite editing",
        ].includes(suite)
          ? [
              ["node", "scripts/reader-coverage.mjs"],
              ["node", "scripts/reader-size.mjs"],
            ]
          : []),
      ]
    : suite === "--suite parsing"
      ? [["pnpm", "test:conformance", "parsing"]]
      : [["pnpm", "audit", "--audit-level=high"]]),
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
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/verify.json",
  JSON.stringify({ suite: suite.slice(8), results }, null, 2) + "\n",
);

process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
