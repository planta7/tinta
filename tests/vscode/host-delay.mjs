import { performance } from "node:perf_hooks";

// Checkpoints locate when a new histogram maximum became observable. They do
// not distinguish host work from OS scheduling or work in another process.
export function traceHostDelay(
  histogram,
  { now = () => performance.now(), cpuUsage = process.cpuUsage } = {},
) {
  const checkpoints = [];
  let maximumMs = 0;
  let previous = now();
  let cpu = cpuUsage();
  let omitted = 0;

  return {
    checkpoint(phase) {
      const timestampMs = now();
      const durationMs = timestampMs - previous;
      const consumed = cpuUsage(cpu);
      const observedMs = histogram.max / 1e6;
      if (checkpoints.length < 256) {
        checkpoints.push({
          phase,
          timestampMs,
          durationMs,
          maximumMs: observedMs,
          newMaximum: observedMs > maximumMs,
          cpuUserMs: consumed.user / 1000,
          cpuSystemMs: consumed.system / 1000,
        });
      } else omitted++;
      maximumMs = Math.max(maximumMs, observedMs);
      previous = timestampMs;
      cpu = cpuUsage();
    },
    report() {
      return {
        method:
          "Cumulative event-loop histogram at workload checkpoints; timestamps " +
          "use the host performance clock. A maximum can become observable " +
          "after the operation that caused it. CPU covers the extension host " +
          "only. No delays are filtered or removed from the performance gate.",
        checkpoints,
        omitted,
      };
    },
  };
}
