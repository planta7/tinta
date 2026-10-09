import { expect, test } from "vitest";
import { parse } from "yaml";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toolInvocation, runCommandSync } from "../../scripts/commands.mjs";
import {
  automatedBlockers,
  performanceExitCode,
  qualificationOptions,
  qualificationExitCode,
} from "../../scripts/qualification-policy.mjs";

test("Windows invocation keeps Unicode paths, spaces and shell characters as literal arguments", () => {
  const args = [
    "--dir",
    "C:\\checks á with spaces",
    "exec",
    "tinta",
    "a & b.tinta",
    "%PATH%",
    "$(command)",
  ];
  const invocation = toolInvocation(["pnpm", ...args], {
    platform: "win32",
    node: "C:\\Program Files\\nodejs\\node.exe",
    env: { npm_execpath: "C:\\tools\\pnpm\\bin\\pnpm.cjs" },
  });
  expect(invocation).toEqual([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\tools\\pnpm\\bin\\pnpm.cjs",
    ...args,
  ]);
  expect(() =>
    toolInvocation(["pnpm", ...args], { platform: "win32", env: {} }),
  ).toThrow("through pnpm");
  expect(
    toolInvocation(["python3", "--version"], {
      platform: "win32",
      env: { TINTA_PYTHON: "C:\\Python tools\\python.exe" },
    }),
  ).toEqual(["C:\\Python tools\\python.exe", "--version"]);
});

test("tool execution preserves literal arguments and propagates nonzero exits", () => {
  const args = ["a b", "á", "&", "%PATH%", "$(command)"];
  const result = runCommandSync([
    "node",
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 7;",
    ...args,
  ]);
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual(args);
  const missing = runCommandSync(["tinta-nonexistent-verification-tool"]);
  expect(missing.status).toBe(null);
  expect(missing.error.code).toBe("ENOENT");
});

test("automation-only options do not permit supplementary measurements in release acceptance", () => {
  expect(qualificationOptions([])).toEqual({
    automatedOnly: false,
    supplementary: false,
  });
  expect(
    qualificationOptions([
      "--automated-only",
      "--performance",
      "supplementary",
    ]),
  ).toEqual({ automatedOnly: true, supplementary: true });
  for (const args of [
    ["--performance", "supplementary"],
    ["--automated-only", "--automated-only"],
    ["--performance", "ignore"],
    ["--evidence"],
    ["--unknown"],
  ])
    expect(() => qualificationOptions(args)).toThrow();
});

test("a green command cannot hide a dirty, changed or unpackaged candidate", () => {
  const candidate = {
    commit: "a".repeat(40),
    dirty: false,
    sourceSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const results = [{ exitCode: 0 }];
  expect(automatedBlockers(candidate, candidate, results)).toEqual([]);
  expect(
    automatedBlockers(candidate, { ...candidate, dirty: true }, results),
  ).toContain("A frozen candidate commit is required.");
  expect(
    automatedBlockers(
      candidate,
      { ...candidate, commit: "d".repeat(40) },
      results,
    ),
  ).toContain("Candidate source changed during verification.");
  expect(
    automatedBlockers(
      candidate,
      { ...candidate, sourceSha256: "changed" },
      results,
    ),
  ).toContain("Candidate source changed during verification.");
  expect(
    automatedBlockers(
      candidate,
      { ...candidate, manifestSha256: undefined },
      results,
    ),
  ).toContain("Candidate artifact manifest is unavailable.");
  for (const failed of [[], [{ exitCode: 1 }], [{ exitCode: null }]])
    expect(automatedBlockers(candidate, candidate, failed)).toContain(
      "One or more automated commands failed.",
    );
});

test("supplementary timing cannot mask incomplete measurements or relax reference budgets", () => {
  expect(
    performanceExitCode({ pass: false, complete: true, supplementary: false }),
  ).toBe(1);
  expect(
    performanceExitCode({ pass: false, complete: true, supplementary: true }),
  ).toBe(0);
  for (const supplementary of [true, false]) {
    expect(
      performanceExitCode({ pass: true, complete: false, supplementary }),
    ).toBe(1);
    expect(
      performanceExitCode({ pass: false, complete: false, supplementary }),
    ).toBe(1);
    expect(
      performanceExitCode({ pass: true, complete: true, supplementary }),
    ).toBe(0);
  }
});

test("automated success retains blocked acceptance and never masks an automated failure", () => {
  const report = { automatedStatus: "PASS", status: "BLOCKED" };
  expect(qualificationExitCode(report, true)).toBe(0);
  expect(qualificationExitCode(report, false)).toBe(1);
  expect(
    qualificationExitCode({ ...report, automatedStatus: "FAIL" }, true),
  ).toBe(1);
  expect(qualificationExitCode({ status: "PASS" }, true)).toBe(1);
});

test("workflow summaries preserve blocked acceptance and reject stale or missing results", () => {
  const temporary = mkdtempSync(join(tmpdir(), "tinta-workflow-summary-"));
  const directory = join(temporary, "reports/verification/qualification");
  const commit = "a".repeat(40);
  const candidate = { commit, sourceSha256: "b".repeat(64) };
  const report = {
    candidate,
    automatedStatus: "PASS",
    status: "BLOCKED",
    automatedCommands: [
      { command: ["node", "synthetic-check.mjs"], exitCode: 0 },
    ],
    acceptanceBlockers: ["Human review not run"],
  };
  const summary = join(temporary, "step-summary.md");
  const invoke = () =>
    runCommandSync(
      ["node", resolve("scripts/qualification-ci.mjs"), "summarize"],
      {
        cwd: temporary,
        env: {
          ...process.env,
          TINTA_EXPECTED_COMMIT: commit,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
  try {
    mkdirSync(directory, { recursive: true });
    expect(invoke().status).toBe(1);
    writeFileSync(
      join(directory, "environment.json"),
      JSON.stringify({ status: "PASS", candidate }),
    );
    writeFileSync(join(directory, "readiness.json"), JSON.stringify(report));
    expect(invoke().status).toBe(0);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("Qualification: BLOCKED");
    expect(text).toContain("Human review not run");
    expect(text).toContain("Reference-machine acceptance remains required");
    report.candidate = { ...candidate, sourceSha256: "changed" };
    writeFileSync(join(directory, "readiness.json"), JSON.stringify(report));
    expect(invoke().status).toBe(1);
    report.candidate = { ...candidate, commit: "c".repeat(40) };
    writeFileSync(join(directory, "readiness.json"), JSON.stringify(report));
    expect(invoke().status).toBe(1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("manual workflow uses one frozen candidate and retains evidence for all native targets", () => {
  const workflow = parse(readFileSync(".github/workflows/qualify.yml", "utf8"));
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.qualify;
  expect(job.needs).toBe("candidate");
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(
    job.strategy.matrix.include.map(({ platform, arch }) => [platform, arch]),
  ).toEqual([
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ]);
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout.with.ref).toBe("${{ needs.candidate.outputs.commit }}");
  expect(checkout.with["persist-credentials"]).toBe(false);
  const upload = job.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(upload.if).toBe("always()");
  expect(upload.with.path).toContain("reports/verification/");
  expect(upload.with.path).toContain("build/qualification/");
  expect(upload.with["include-hidden-files"]).toBe(true);
  expect(job.steps.some((step) => step["continue-on-error"])).toBe(false);
  const provenance = JSON.parse(readFileSync("toolchain/actions.json", "utf8"));
  for (const step of [...workflow.jobs.candidate.steps, ...job.steps].filter(
    (step) => step.uses,
  )) {
    const [name, sha] = step.uses.split("@");
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(
      provenance.some(
        (record) =>
          record.repository === `https://github.com/${name}` &&
          record.commit === sha,
      ),
    ).toBe(true);
  }
});
