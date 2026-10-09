import { expect, test } from "vitest";
import { assessStudioRuns } from "../../scripts/performance-policy.mjs";

function runs() {
  return Array.from({ length: 3 }, () => ({
    typing: Array.from({ length: 50 }, () => ({
      start: 1000,
      end: 1100,
      previewEnd: 2000,
      trusted: true,
      tasks: [{ start: 1000, duration: 200, context: "self" }],
    })),
    controls: Array.from({ length: 50 }, () => ({
      start: 3000,
      end: 3150,
      trusted: true,
      tasks: [],
    })),
  }));
}

test("interaction budgets accept exact boundaries and retain long-task diagnostics", () => {
  const result = assessStudioRuns(runs());
  expect(result.pass).toBe(true);
  expect(result.summaries[0].longTasks).toEqual({
    count: 50,
    maximum: 200,
    excessMilliseconds: 7500,
    actionFraction: 0.5,
  });
});

test.each(["typing", "controls", "preview"])(
  "a failing %s p95 in any run exceeds the interaction budget",
  (metric) => {
    const samples = runs();
    const records =
      metric === "controls" ? samples[1].controls : samples[1].typing;
    for (const record of records.slice(0, 3)) {
      if (metric === "preview") record.previewEnd += 1;
      else record.end += 1;
    }
    expect(assessStudioRuns(samples).pass).toBe(false);
  },
);

test("one extreme task exceeds the budget even when interaction percentiles pass", () => {
  const samples = runs();
  samples[2].typing[0].tasks[0].duration = 201;
  expect(assessStudioRuns(samples).pass).toBe(false);
});

test("missing runs, missing samples and invalid timestamps cannot pass", () => {
  expect(assessStudioRuns([]).pass).toBe(false);
  expect(assessStudioRuns(runs().slice(1)).pass).toBe(false);
  const missing = runs();
  missing[0].typing.pop();
  expect(assessStudioRuns(missing).pass).toBe(false);
  const invalid = runs();
  invalid[0].controls[0].end = NaN;
  expect(assessStudioRuns(invalid).pass).toBe(false);
  const untrusted = runs();
  untrusted[0].typing[0].trusted = false;
  expect(assessStudioRuns(untrusted).pass).toBe(false);
});
