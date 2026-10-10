import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operate } from "../../apps/vscode/dist/artifact-worker/operation.js";
import { runArtifact } from "../../apps/vscode/dist/artifacts.js";

const state = vi.hoisted(() => ({ workers: [] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor(url) {
        super();
        this.url = url;
        state.workers.push(this);
      }
      postMessage = vi.fn();
      terminate = vi.fn(async () => 0);
    },
  };
});
beforeEach(() => {
  state.workers.length = 0;
});
afterEach(() => vi.useRealTimers());
const request = {
  kind: "enrich",
  source: { text: "# Text", profile: "markdown", uri: "tinta:test" },
};

describe("artifact worker lifecycle", () => {
  it("uses only the fixed bundle and terminates after success", async () => {
    const result = runArtifact(request, new AbortController().signal);
    const worker = state.workers[0];
    expect(worker.url.pathname).toMatch(/artifact-worker.mjs$/);
    expect(worker.postMessage).toHaveBeenCalledWith(request);
    worker.emit("message", {
      kind: "enrich",
      enrichment: { source: "# Text" },
    });
    expect((await result).kind).toBe("enrich");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates on cancellation, timeout, error and exit, allowing fresh work", async () => {
    vi.useFakeTimers();
    for (const event of ["abort", "timeout", "error", "exit", "validation"]) {
      const controller = new AbortController();
      const result = runArtifact(request, controller.signal);
      const rejection = expect(result).rejects.toThrow();
      const worker = state.workers.at(-1);
      if (event === "abort") controller.abort();
      else if (event === "timeout") await vi.advanceTimersByTimeAsync(3001);
      else if (event === "validation")
        worker.emit("message", {
          kind: "error",
          code: "E_BUNDLE",
          message: "Invalid archive.",
        });
      else worker.emit(event);
      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() => runArtifact(request, cancelled.signal)).toThrow();
  });

  it("preserves authoritative compilation and initial evaluation errors", async () => {
    for (const text of ["@calc x = missing", "@calc x = 1 / 0"]) {
      const reply = await operate({
        kind: "inspect",
        source: { text, profile: "tinta", uri: "tinta:test" },
        format: "static",
        assets: new Map(),
      });
      expect(reply.kind).toBe("error");
      expect(reply.code).not.toBe("E_INTERNAL");
    }
    const enriched = await operate({
      ...request,
      source: { ...request.source, text: "Literal {{ amount }}" },
    });
    expect(enriched.kind).toBe("enrich");
    expect(enriched.enrichment.edits.length).toBeGreaterThan(0);
    expect(
      (await operate({ kind: "open", bytes: new Uint8Array() })).kind,
    ).toBe("error");
    expect((await operate({ kind: "produce", source: null })).code).toBe(
      "E_INTERNAL",
    );
  });
});
