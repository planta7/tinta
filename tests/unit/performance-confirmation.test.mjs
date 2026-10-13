import { describe, expect, it, vi } from "vitest";
import {
  confirmPerformance,
  emitPerformanceWarnings,
  performanceStatus,
  responsivenessWithinBudget,
  samplesWithinBudget,
} from "../vscode/performance-confirmation.mjs";

const withinBudget = (measurement) => measurement.p95Ms < 50;
const sample = (p95Ms) => ({ p95Ms, samples: [p95Ms, 1000] });

describe("conditional performance confirmation", () => {
  it("does not repeat a passing scenario", async () => {
    const initial = sample(49);
    const measure = vi.fn();
    const result = await confirmPerformance(initial, measure, withinBudget);
    expect(result).toEqual({ status: "PASS", attempts: [initial] });
    expect(measure).not.toHaveBeenCalled();
  });

  it("keeps a first failure and performs both confirmations even if the second passes", async () => {
    const initial = sample(79);
    const second = sample(10);
    const third = sample(14);
    const measure = vi
      .fn()
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const result = await confirmPerformance(initial, measure, withinBudget);
    expect(result.status).toBe("UNSTABLE");
    expect(result.attempts).toEqual([initial, second, third]);
    expect(result.attempts[0]).toBe(initial);
    expect(result.attempts[0].samples).toEqual([79, 1000]);
    expect(measure.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    [60, 10],
    [10, 60],
    [60, 70],
  ])("blocks repeated budget failures (%s, %s)", async (second, third) => {
    const measure = vi
      .fn()
      .mockResolvedValueOnce(sample(second))
      .mockResolvedValueOnce(sample(third));
    const result = await confirmPerformance(sample(50), measure, withinBudget);
    expect(result.status).toBe("FAIL");
    expect(result.attempts).toHaveLength(3);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("never repeats a functional error and retains earlier measurements", async () => {
    const measure = vi.fn().mockRejectedValue(new Error("Invalid completion"));
    let retained;
    await expect(
      confirmPerformance(sample(70), measure, withinBudget, (value) => {
        retained = value;
      }),
    ).rejects.toThrow("Invalid completion");
    expect(measure).toHaveBeenCalledOnce();
    expect(retained.status).toBe("FAIL");
    expect(retained.attempts).toEqual([sample(70)]);
    expect(retained.error).toContain("Invalid completion");
  });

  it("fails an invalid assessment without executing another measurement", async () => {
    const measure = vi.fn();
    await expect(
      confirmPerformance(sample(10), measure, () => undefined),
    ).rejects.toThrow("boolean");
    expect(measure).not.toHaveBeenCalled();
  });

  it("repeats only the failing scenario in a group", async () => {
    const passing = vi.fn();
    const failing = vi.fn().mockResolvedValue(sample(10));
    const results = await Promise.all([
      confirmPerformance(sample(10), passing, withinBudget),
      confirmPerformance(sample(80), failing, withinBudget),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "PASS",
      "UNSTABLE",
    ]);
    expect(passing).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it.each(
    [[], Array(29).fill(10), Array(30).fill(NaN), Array(30).fill(-1)].map(
      (samples) => [samples],
    ),
  )(
    "blocks incomplete or invalid sample blocks without confirmation",
    async (samples) => {
      const measure = vi.fn();
      await expect(
        confirmPerformance({ samples, p95Ms: 10 }, measure, (value) =>
          samplesWithinBudget(value, 50),
        ),
      ).rejects.toThrow("Incomplete or invalid");
      expect(measure).not.toHaveBeenCalled();
    },
  );

  it("stops before the third measurement when the second has invalid data", async () => {
    const measure = vi.fn().mockResolvedValue({ samples: [], p95Ms: 10 });
    await expect(
      confirmPerformance(
        { samples: Array(30).fill(70), p95Ms: 70 },
        measure,
        (value) => samplesWithinBudget(value, 50),
      ),
    ).rejects.toThrow("Incomplete or invalid");
    expect(measure).toHaveBeenCalledOnce();
  });

  it("uses the unchanged strict p95 and inclusive maximum boundaries", () => {
    expect(
      samplesWithinBudget({ samples: Array(30).fill(49), p95Ms: 49 }, 50),
    ).toBe(true);
    expect(
      samplesWithinBudget({ samples: Array(30).fill(50), p95Ms: 50 }, 50),
    ).toBe(false);
    expect(
      responsivenessWithinBudget({ count: 30, loopP95Ms: 49, loopMaxMs: 100 }),
    ).toBe(true);
    expect(
      responsivenessWithinBudget({ count: 30, loopP95Ms: 50, loopMaxMs: 100 }),
    ).toBe(false);
    expect(
      responsivenessWithinBudget({ count: 30, loopP95Ms: 49, loopMaxMs: 101 }),
    ).toBe(false);
    expect(() =>
      responsivenessWithinBudget({ count: 0, loopP95Ms: 0, loopMaxMs: 0 }),
    ).toThrow("Incomplete or invalid");
  });

  it("does not let an isolated timing failure rescue a resource failure", () => {
    const confirmations = { completion: { status: "UNSTABLE" } };
    expect(performanceStatus(confirmations, true)).toBe("UNSTABLE");
    expect(performanceStatus(confirmations, false)).toBe("FAIL");
    expect(performanceStatus({ completion: { status: "FAIL" } }, true)).toBe(
      "FAIL",
    );
  });

  it.each([true, false])(
    "emits visible warnings (GitHub Actions=%s)",
    (githubActions) => {
      const log = vi.fn();
      emitPerformanceWarnings(
        { warnings: ["completion: UNSTABLE"] },
        { githubActions, log },
      );
      expect(log).toHaveBeenCalledWith(
        githubActions
          ? "::warning title=Unstable native performance::completion: UNSTABLE"
          : "WARNING: completion: UNSTABLE",
      );
      log.mockClear();
      emitPerformanceWarnings(undefined, { githubActions, log });
      expect(log).not.toHaveBeenCalled();
    },
  );
});
