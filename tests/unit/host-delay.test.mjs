import { expect, it } from "vitest";
import { traceHostDelay } from "../vscode/host-delay.mjs";

it("retains an over-budget delay and its observation checkpoint", () => {
  const histogram = { max: 12_000_000 };
  let time = 0;
  const trace = traceHostDelay(histogram, {
    now: () => time,
    cpuUsage: () => ({ user: 1000, system: 2000 }),
  });
  time = 10;
  trace.checkpoint("analysis:small");
  histogram.max = 113_770_495;
  time = 150;
  trace.checkpoint("analysis:large");
  time = 160;
  trace.checkpoint("completion");
  expect(trace.report().checkpoints[1]).toMatchObject({
    phase: "analysis:large",
    durationMs: 140,
    maximumMs: 113.770495,
    newMaximum: true,
  });
  expect(trace.report().checkpoints[2].newMaximum).toBe(false);
  expect(histogram.max).toBe(113_770_495);
});

it("bounds diagnostic output without resetting the measured histogram", () => {
  const histogram = { max: 101_000_000 };
  const trace = traceHostDelay(histogram);
  for (let index = 0; index < 300; index++) trace.checkpoint("analysis");
  expect(trace.report().checkpoints).toHaveLength(256);
  expect(trace.report().omitted).toBe(44);
  expect(histogram.max).toBe(101_000_000);
});
