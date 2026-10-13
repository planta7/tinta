import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  now: 0,
  analysis: new Map(),
  completionCalls: 0,
  completionBlocks: [10],
  invalidCompletionBlock: -1,
  loopBlocks: [10],
  loopIndex: 0,
  samplers: [],
  edits: 0,
  rssGrowth: 1024,
  documents: [],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage({ text }) {
        const count = state.analysis.get(text.length) ?? 0;
        state.analysis.set(text.length, count + 1);
        state.now += text.length === 10240 && count < 33 ? 250 : 10;
        this.emit("message", {
          result: { ok: true, value: { validity: "valid" } },
        });
      }
      async terminate() {}
    },
  };
});

vi.mock("node:perf_hooks", () => ({
  performance: { now: () => state.now },
  monitorEventLoopDelay: () => {
    const delay = state.loopBlocks[state.loopIndex++] ?? 10;
    return {
      enable() {},
      disable() {},
      percentile: () => delay * 1e6,
      max: delay * 1e6,
      count: 100,
    };
  },
}));
vi.mock("node:v8", () => ({ setFlagsFromString() {} }));
vi.mock("node:vm", () => ({ runInNewContext: () => () => {} }));
vi.mock("../vscode/resident-sampler.mjs", () => ({
  startResidentSampler: () => {
    const sampler = {
      ready: Promise.resolve(),
      stop: vi.fn(async () => ({
        baselineRss: 1024,
        peakRss: 1024 + state.rssGrowth,
      })),
      dispose: vi.fn(async () => {}),
    };
    state.samplers.push(sampler);
    return sampler;
  },
}));
vi.mock("vscode", () => ({
  extensions: { getExtension: () => ({ extensionPath: "/installed" }) },
  Position: class {},
  Range: class {},
  WorkspaceEdit: class {
    replace() {}
  },
  ViewColumn: { One: 1 },
  window: { showTextDocument: async () => {} },
  workspace: {
    get textDocuments() {
      return state.documents;
    },
    applyEdit: async () => {
      state.edits++;
      return true;
    },
  },
  commands: {
    executeCommand: async (command) => {
      if (command === "vscode.executeCompletionItemProvider") {
        const block = Math.floor(state.completionCalls++ / 31);
        state.now += state.completionBlocks[block] ?? 10;
        return {
          items:
            state.invalidCompletionBlock === block ? [] : [{ label: "amount" }],
        };
      }
      if (command === "vscode.executeDefinitionProvider") return [{}];
    },
  },
}));

import { measureInstalled } from "../vscode/installed-performance.mjs";

const open = async (name) => ({ uri: { fsPath: `/workspace/${name}` } });

beforeEach(() => {
  state.now = 0;
  state.analysis = new Map();
  state.completionCalls = 0;
  state.completionBlocks = [10];
  state.invalidCompletionBlock = -1;
  state.loopBlocks = [10];
  state.loopIndex = 0;
  state.samplers = [];
  state.edits = 0;
  state.rssGrowth = 1024;
  state.documents = [];
  vi.stubEnv("TINTA_INSTALLED_ROOT", "/profile");
  vi.spyOn(process, "memoryUsage").mockReturnValue({ heapUsed: 1024 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("installed timing confirmation", () => {
  it("repeats only the exceeded analysis size and keeps all three full blocks", async () => {
    const report = await measureInstalled(open);
    expect(report.status).toBe("UNSTABLE");
    expect([...state.analysis.entries()]).toEqual([
      [10240, 99],
      [102400, 33],
      [1048576, 33],
    ]);
    expect(state.completionCalls).toBe(31);
    expect(state.edits).toBe(20);
    const confirmation = report.confirmations["analysis-10240"];
    expect(confirmation.attempts.map((value) => value.p95Ms)).toEqual([
      250, 10, 10,
    ]);
    expect(
      confirmation.attempts.every((value) => value.samples.length === 30),
    ).toBe(true);
    expect(report.analysis[0].samples).toEqual(Array(30).fill(250));
    expect(report.warnings).toEqual([
      "analysis-10240: one of three measurements exceeded its timing budget; both confirmations passed (UNSTABLE).",
    ]);
    expect(state.samplers).toHaveLength(3);
    expect(
      state.samplers.every((sampler) => sampler.stop.mock.calls.length === 1),
    ).toBe(true);
    expect(
      state.samplers.every((sampler) => sampler.dispose.mock.calls.length >= 1),
    ).toBe(true);
  });

  it("confirms cached completion without rerunning responsiveness or rapid edits", async () => {
    state.completionBlocks = [79, 10, 14];
    const report = await measureInstalled(open);
    expect(report.status).toBe("UNSTABLE");
    expect(state.completionCalls).toBe(93);
    expect(state.edits).toBe(20);
    expect(state.loopIndex).toBe(1);
    expect(report.completionP95Ms).toBe(79);
    expect(
      report.confirmations.completion.attempts.map((value) => value.p95Ms),
    ).toEqual([79, 10, 14]);
  });

  it("blocks completion when a confirmation also exceeds its budget", async () => {
    state.completionBlocks = [79, 60, 10];
    const report = await measureInstalled(open);
    expect(report.status).toBe("FAIL");
    expect(report.confirmations.completion.status).toBe("FAIL");
    expect(state.completionCalls).toBe(93);
  });

  it("repeats the complete timed workload for host responsiveness", async () => {
    state.loopBlocks = [101, 10, 10];
    const report = await measureInstalled(open);
    expect(report.status).toBe("UNSTABLE");
    expect(state.edits).toBe(60);
    expect(state.completionCalls).toBe(93);
    expect(state.analysis.get(102400)).toBe(99);
    expect(state.analysis.get(1048576)).toBe(99);
    expect(report.loopMaxMs).toBe(101);
    const attempts = report.confirmations.responsiveness.attempts;
    expect(attempts.map((value) => value.loopMaxMs)).toEqual([101, 10, 10]);
    expect(
      attempts[1].analysis.every((value) => value.samples.length === 30),
    ).toBe(true);
    expect(attempts[2].completion.samples).toHaveLength(30);
  });

  it("keeps memory failure blocking even if timing confirmations pass", async () => {
    state.rssGrowth = 512 * 1024 ** 2 + 1;
    const report = await measureInstalled(open);
    expect(report.status).toBe("FAIL");
    expect(report.rssGrowth).toBe(state.rssGrowth);
    expect(report.confirmations["analysis-10240"].status).toBe("UNSTABLE");
  });

  it("stops on a functional confirmation failure and retains the initial report", async () => {
    state.completionBlocks = [79];
    state.invalidCompletionBlock = 1;
    let retained;
    await expect(
      measureInstalled(open, (value) => {
        retained = value;
      }),
    ).rejects.toThrow();
    expect(retained.status).toBe("FAIL");
    expect(retained.completionSamples).toEqual(Array(30).fill(79));
    expect(retained.confirmations.completion.attempts).toHaveLength(1);
    expect(state.completionCalls).toBe(33);
    expect(state.loopIndex).toBe(1);
    expect(state.samplers.at(-1).dispose).toHaveBeenCalledOnce();
  });
});
