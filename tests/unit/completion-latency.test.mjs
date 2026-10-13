import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { traceCompletionLatency } from "../vscode/completion-latency.mjs";

function fixture() {
  let time = 0;
  const child = new EventEmitter();
  child.send = vi.fn(() => false);
  const originalSend = child.send;
  const originalFork = vi.fn(() => child);
  const processes = { fork: originalFork };
  const sync = vi.fn();
  const trace = traceCompletionLatency("/installed/server.mjs", {
    processes,
    sync,
    now: () => time,
  });
  return {
    child,
    originalSend,
    originalFork,
    processes,
    sync,
    trace,
    tick: (value) => {
      time = value;
    },
  };
}

describe("installed completion latency trace", () => {
  it("splits command latency while preserving IPC arguments, return and delivery", () => {
    const f = fixture();
    const options = { silent: true };
    f.processes.fork("/installed/server.mjs", [], options);
    expect(f.originalFork).toHaveBeenCalledWith(
      "/installed/server.mjs",
      [],
      options,
    );
    const receive = vi.fn();
    f.child.on("message", receive);
    f.trace.begin(0);
    f.tick(20);
    const request = {
      id: 7,
      method: "textDocument/completion",
      params: { text: "private" },
    };
    const callback = () => {};
    expect(f.child.send(request, callback)).toBe(false);
    expect(f.originalSend).toHaveBeenCalledWith(request, callback);
    f.tick(22);
    const response = { id: 7, result: ["private"] };
    f.child.emit("message", response);
    expect(receive).toHaveBeenCalledWith(response);
    f.tick(60);
    f.trace.end();
    expect(f.trace.report().samples[0]).toMatchObject({
      totalMs: 60,
      beforeServerMs: 20,
      serverRoundTripMs: 2,
      afterServerMs: 38,
      requestCount: 1,
    });
    expect(JSON.stringify(f.trace.report())).not.toContain("private");
    f.trace.dispose();
    expect(f.processes.fork).toBe(f.originalFork);
    expect(f.child.send).toBe(f.originalSend);
    expect(f.child.listenerCount("message")).toBe(1);
    expect(f.sync).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated processes and reports missing IPC instead of fabricating timings", () => {
    const f = fixture();
    f.processes.fork("/other/server.mjs");
    f.trace.begin(0);
    f.child.send({ id: 1, method: "textDocument/completion" });
    f.tick(51);
    f.trace.dispose();
    expect(f.trace.report()).toMatchObject({
      attachedServers: 0,
      samples: [
        {
          totalMs: 51,
          beforeServerMs: null,
          serverRoundTripMs: null,
          afterServerMs: null,
          events: [],
        },
      ],
    });
  });

  it("bounds events and samples and retains partial samples during failure cleanup", () => {
    const f = fixture();
    f.processes.fork("/installed/server.mjs");
    f.trace.begin(0);
    for (let index = 0; index < 200; index++)
      f.child.emit("message", {
        id: index,
        method: "workspace/semanticTokens/refresh",
      });
    f.trace.dispose();
    expect(f.trace.report().samples[0].events).toHaveLength(128);
    expect(f.trace.report().droppedEvents).toBe(72);
    for (let index = 1; index < 30; index++) {
      f.trace.begin(index);
      f.trace.end();
    }
    expect(() => f.trace.begin(30)).toThrow("Invalid latency sample");
  });
});
