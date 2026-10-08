import { reviewBlockers } from "./qualification-evidence.mjs";
import { captureCandidate } from "./candidate.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const initialCandidate = captureCandidate();
const directory = "reports/verification/qualification";
mkdirSync(directory, { recursive: true });
const commands = [
  ["pnpm", "install", "--frozen-lockfile", "--offline"],
  ["pnpm", "verify", "--suite", "editing"],
  ["pnpm", "exec", "vitest", "run", "--testTimeout=120000"],
  ["pnpm", "audit", "--json"],
  ["node", "scripts/traceability.mjs"],
  ["node", "scripts/qualification-package.mjs"],
  ["node", "scripts/benchmark.mjs"],
];
const results = [];
for (const command of commands) {
  const start = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TINTA_PROPERTY_RUNS: "10000" },
  });
  const log = `${directory}/command-${results.length + 1}.log`;
  writeFileSync(log, (result.stdout ?? "") + (result.stderr ?? ""));
  results.push({
    command,
    start,
    exitCode: result.status,
    error: result.error?.message,
    log,
  });
  console.log(`${result.status === 0 ? "PASS" : "FAIL"}: ${command.join(" ")}`);
}
const manifest = readFileSync("build/qualification/manifest.json");
const candidate = {
  ...captureCandidate(),
  manifestSha256: createHash("sha256").update(manifest).digest("hex"),
};
let evidence;
if (process.argv.length === 4 && process.argv[2] === "--evidence") {
  evidence = JSON.parse(readFileSync(process.argv[3], "utf8"));
} else if (process.argv.length !== 2) {
  throw new Error(
    "Usage: node scripts/qualification.mjs [--evidence review.json]",
  );
}
const blockers = reviewBlockers(evidence, candidate);
if (candidate.sourceSha256 !== initialCandidate.sourceSha256) {
  blockers.push("Candidate source changed during verification.");
}
if (results.some((result) => result.exitCode !== 0)) {
  blockers.push("One or more automated commands failed.");
}
const report = {
  status: blockers.length ? "BLOCKED" : "PASS",
  automatedCommands: results,
  candidate,
  blockers,
  publicationAuthorized: false,
};
writeFileSync(
  `${directory}/readiness.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `${report.status}: review reports/verification/qualification/readiness.json`,
);
process.exitCode = blockers.length ? 1 : 0;
