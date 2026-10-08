import { test, expect, vi } from "vitest";

test("worker validates commands, revisions, initial evaluation and cancellation", async () => {
  const responses = [];
  let receive;
  vi.stubGlobal("self", {
    addEventListener: (_type, listener) => {
      receive = listener;
    },
    postMessage: (value) => responses.push(value),
  });
  try {
    await import("../../apps/studio/dist/worker.js");
    const base = {
      protocol: "tinta-host-1",
      documentId: "a".repeat(32),
      capability: "b".repeat(32),
      requestId: 1,
      sourceRevision: 1,
    };
    receive({ data: null });
    receive({ data: { ...base, kind: "fetch", source: "ignored" } });
    expect(responses).toEqual([]);
    receive({
      data: {
        ...base,
        kind: "compile",
        source: "# Checked",
        profile: "tinta",
        uri: "tinta:/document.tinta",
      },
    });
    expect(responses.at(-1).kind).toBe("compiled");
    const count = responses.length;
    receive({
      data: {
        ...base,
        kind: "compile",
        source: "# Stale",
        profile: "tinta",
        uri: "tinta:/document.tinta",
      },
    });
    expect(responses).toHaveLength(count);
    receive({
      data: {
        ...base,
        requestId: 2,
        sourceRevision: 2,
        kind: "compile",
        source: "@calc bad =",
        profile: "tinta",
        uri: "tinta:/document.tinta",
      },
    });
    expect(responses.at(-1).kind).toBe("rejected");
    receive({
      data: {
        ...base,
        requestId: 3,
        sourceRevision: 3,
        kind: "compile",
        source: "@slider value = 0 (min: 0, max: 2)\n{{ 1 / value }}",
        profile: "tinta",
        uri: "tinta:/document.tinta",
      },
    });
    expect(responses.at(-1).kind).toBe("rejected");
    receive({
      data: {
        ...base,
        requestId: 4,
        sourceRevision: 4,
        kind: "cancel",
        targetRequestId: 3,
      },
    });
    expect(responses.at(-1).kind).toBe("cancelled");
  } finally {
    vi.unstubAllGlobals();
  }
});
