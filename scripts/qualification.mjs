import { reviewBlockers } from "./qualification-evidence.mjs";
import { captureCandidate } from "./candidate.mjs";
import { runCommandSync } from "./commands.mjs";
import {
  automatedBlockers,
  qualificationOptions,
  qualificationExitCode,
} from "./qualification-policy.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const options = qualificationOptions(process.argv.slice(2));
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
  ["node", "scripts/installed-cli.mjs"],
  [
    "node",
    "scripts/benchmark.mjs",
    ...(options.supplementary ? ["--supplementary"] : []),
  ],
];
const results = [];
for (const command of commands) {
  const start = new Date().toISOString();
  let result;
  try {
    result = runCommandSync(command, {
      env: { ...process.env, TINTA_PROPERTY_RUNS: "10000" },
    });
  } catch (error) {
    result = { status: null, error };
  }
  const log = `${directory}/command-${results.length + 1}.log`;
  writeFileSync(
    log,
    (result.stdout ?? "") +
      (result.stderr ?? "") +
      (result.error?.message ?? ""),
  );
  results.push({
    command,
    start,
    end: new Date().toISOString(),
    exitCode: result.status,
    error: result.error?.message,
    log,
  });
  console.log(`${result.status === 0 ? "PASS" : "FAIL"}: ${command.join(" ")}`);
}
const candidate = captureCandidate();
try {
  const manifest = readFileSync("build/qualification/manifest.json");
  candidate.manifestSha256 = createHash("sha256")
    .update(manifest)
    .digest("hex");
} catch (error) {
  candidate.manifestError = error.message;
}
let evidence;
if (options.evidencePath)
  evidence = JSON.parse(readFileSync(options.evidencePath, "utf8"));
const automatic = automatedBlockers(initialCandidate, candidate, results);
const acceptance = reviewBlockers(evidence, candidate);
if (options.supplementary)
  acceptance.push("Reference-machine performance acceptance remains required.");
const blockers = [...new Set([...automatic, ...acceptance])];
const report = {
  status: blockers.length ? "BLOCKED" : "PASS",
  automatedStatus: automatic.length ? "FAIL" : "PASS",
  automatedOnly: options.automatedOnly,
  performanceRole: options.supplementary ? "SUPPLEMENTARY" : "REFERENCE",
  automatedCommands: results,
  candidate,
  automatedBlockers: automatic,
  acceptanceBlockers: acceptance,
  blockers,
  publicationAuthorized: false,
};
writeFileSync(
  `${directory}/readiness.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Automated checks: ${report.automatedStatus}; qualification: ${report.status}. ` +
    `Review ${directory}/readiness.json`,
);
process.exitCode = qualificationExitCode(report, options.automatedOnly);
