import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem, release } from "node:os";
import { createRequire } from "node:module";
import { captureCandidate } from "./candidate.mjs";
import { requireCommandSync } from "./commands.mjs";

const directory = "reports/verification/qualification";
mkdirSync(directory, { recursive: true });
const expected = process.env.TINTA_EXPECTED_COMMIT;

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function prepare() {
  const environment = {
    utc: new Date().toISOString(),
    expectedCommit: expected,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    node: process.versions.node,
    cpu: cpus()[0]?.model,
    ramBytes: totalmem(),
    runnerImage: process.env.ImageOS,
    runnerImageVersion: process.env.ImageVersion,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowRevision: process.env.GITHUB_SHA,
    status: "IN_PROGRESS",
  };
  try {
    const candidate = captureCandidate();
    environment.candidate = candidate;
    const manifest = read("package.json");
    const require = createRequire(import.meta.url);
    environment.pnpm = requireCommandSync(["pnpm", "--version"]).stdout.trim();
    environment.python = requireCommandSync([
      "python3",
      "--version",
    ]).stdout.trim();
    environment.pythonExecutable = process.env.TINTA_PYTHON;
    environment.playwright = require("@playwright/test/package.json").version;
    environment.browserRevisions = read("toolchain/browsers.json");
    if (
      candidate.dirty ||
      candidate.commit !== expected ||
      process.platform !== process.env.TINTA_EXPECTED_PLATFORM ||
      process.arch !== process.env.TINTA_EXPECTED_ARCH ||
      environment.node !== manifest.engines.node ||
      environment.pnpm !== manifest.engines.pnpm ||
      environment.python !== "Python 3.13.7" ||
      environment.playwright !== manifest.devDependencies["@playwright/test"]
    )
      throw new Error(
        "Candidate or native toolchain does not match the requested qualification environment.",
      );
    environment.status = "PASS";
  } catch (error) {
    environment.status = "FAIL";
    environment.error = String(error);
    process.exitCode = 1;
  }
  writeFileSync(
    `${directory}/environment.json`,
    JSON.stringify(environment, null, 2) + "\n",
  );
  console.log(`${environment.status}: native qualification preflight`);
}

function summarize() {
  const report = read(`${directory}/readiness.json`);
  const environment = read(`${directory}/environment.json`);
  const performance = read("reports/verification/performance.json");
  const valid =
    environment?.status === "PASS" &&
    environment?.candidate?.commit === expected &&
    environment?.candidate?.sourceSha256 === report?.candidate?.sourceSha256 &&
    report?.candidate?.commit === expected &&
    report?.automatedStatus === "PASS";
  const summary = [
    `### ${process.platform} / ${process.arch}: automated checks ${valid ? "PASS" : "FAIL or NOT_RUN"}`,
    "",
    `Candidate: ${expected}`,
    "",
    `Qualification: ${report?.status ?? "NOT_RUN"}. Publication is not authorized.`,
    "",
    `Supplementary performance targets: ${performance?.status ?? "NOT_RUN"}. Reference-machine acceptance remains required.`,
    "",
    ...(report?.automatedCommands ?? []).map(
      ({ command, exitCode }) =>
        `- ${exitCode === 0 ? "PASS" : "FAIL"}: \`${command.join(" ")}\` (exit ${exitCode})`,
    ),
    "",
    "Outstanding acceptance:",
    "",
    ...(report?.acceptanceBlockers ?? ["Qualification did not complete."]).map(
      (item) => `- ${item}`,
    ),
    "",
    "Download the platform artifact for raw logs, environment versions, source/artifact hashes and individual results.",
    "",
  ].join("\n");
  writeFileSync(`${directory}/summary.md`, summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!valid) process.exitCode = 1;
}

if (process.argv.length !== 3)
  throw new Error("Usage: node scripts/qualification-ci.mjs prepare|summarize");
if (process.argv[2] === "prepare") prepare();
else if (process.argv[2] === "summarize") summarize();
else throw new Error("Unknown qualification workflow operation");
