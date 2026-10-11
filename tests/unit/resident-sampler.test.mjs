import { expect, it } from "vitest";
import { startResidentSampler } from "../vscode/resident-sampler.mjs";

it("collects real process memory outside the measured host thread", async () => {
  const sampler = startResidentSampler(
    new URL("../vscode/resident-sampler-worker.mjs", import.meta.url),
  );
  try {
    const ready = await sampler.ready;
    expect(ready.type).toBe("ready");
    expect(ready.baselineRss).toBeGreaterThan(0);
    const result = await sampler.stop();
    expect(result.baselineRss).toBe(ready.baselineRss);
    expect(result.peakRss).toBeGreaterThanOrEqual(result.baselineRss);
  } finally {
    await sampler.dispose();
  }
});

it("reports a collector startup error instead of inventing a measurement", async () => {
  const sampler = startResidentSampler(
    new URL("data:text/javascript,throw new Error('collector failed')"),
  );
  try {
    await expect(sampler.ready).rejects.toThrow("collector failed");
    await expect(sampler.stop()).rejects.toThrow("collector failed");
  } finally {
    await sampler.dispose();
  }
});
