import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL(
      "../../.github/workflows/diagnose-installed-performance.yml",
      import.meta.url,
    ),
    "utf8",
  ),
);

it("keeps performance diagnosis manual and limits token access to reads", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({
    contents: "read",
    actions: "read",
  });
  for (const job of Object.values(workflow.jobs)) {
    expect(job["runs-on"]).toBe("windows-2022");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    expect(job.permissions).toBeUndefined();
    for (const step of job.steps) {
      if (step.uses) {
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        expect(step.uses).not.toMatch(/publish|deploy|attest/i);
      }
      if (step.run) {
        expect(step.run).not.toContain("${{ inputs.");
        expect(step.run).not.toMatch(/@latest\b|git push|npm publish/i);
      }
    }
  }
});
