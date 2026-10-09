import { describe, test, expect } from "vitest";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  reconcile,
  safeFilename,
  profileFor,
} from "../../apps/studio/dist/model.js";
import {
  sourceOffset,
  editorOffset,
  normalizedSource,
} from "../../apps/studio/dist/source-buffer.js";
import { retainedRecoveries } from "../../apps/studio/dist/recovery.js";
import { base, controls, exact } from "../../apps/studio/dist/protocol.js";
import { snippets } from "../../apps/studio/dist/studio-runtime.js";

const program = (source) => {
  const result = compile({
    text: source,
    profile: "tinta",
    uri: "tinta:/test.tinta",
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.value;
};
describe("source reconciliation", () => {
  test("retains prose-only answers, resets changed initial/domain and removes controls", () => {
    const source =
      "@slider amount = 2 (min: 0, max: 10)\n@toggle extra = false\n";
    const old = createSession(program(source)).value;
    old.setControl("amount", 7);
    old.setControl("extra", true);
    const prose = reconcile(program(source + "\nNew prose.\n"), old);
    expect(prose.result.value.getRevision().state.amount).toBe(7);
    expect(prose.reset).toEqual([]);
    const changed = reconcile(
      program("@slider amount = 3 (min: 0, max: 10)\n"),
      old,
    );
    expect(changed.result.value.getRevision().state).toEqual({ amount: 3 });
    expect(changed.reset).toEqual(["amount"]);
  });
  test("a failing retained candidate falls back atomically to authored values", () => {
    const old = createSession(
      program("@slider amount = 1 (min: 0, max: 10)\n"),
    ).value;
    old.setControl("amount", 0);
    const result = reconcile(
      program("@slider amount = 1 (min: 0, max: 10)\n{{ 1 / amount }}"),
      old,
    );
    expect(result.result.value.getRevision().state.amount).toBe(1);
    expect(result.reset).toEqual(["amount"]);
  });
});
test("preserves offsets across BOM and mixed line endings", () => {
  const source = "\uFEFFa\r\nb\nc\rd";
  const normalized = normalizedSource(source);
  for (let i = 0; i <= normalized.length; i++)
    expect(editorOffset(source, sourceOffset(source, i))).toBe(i);
  expect(sourceOffset(source, 4)).toBe(5);
});
test("recovery eviction retains active source and enforces entry limits", () => {
  const entry = (id, edited) => ({
    id,
    edited,
    source: "# Draft",
    filename: "draft.tinta",
    profile: "tinta",
    assets: [],
  });
  const entries = Array.from({ length: 10 }, (_, i) => entry(String(i), i));
  expect(
    retainedRecoveries(entries.slice(1), entry("active", -1)),
  ).toHaveLength(10);
  const result = retainedRecoveries(entries, entry("active", -1));
  expect(result).toHaveLength(10);
  expect(result.some((e) => e.id === "active")).toBe(true);
  expect(result.some((e) => e.id === "0")).toBe(false);
});
test("transport rejects forged identities, excess commands and unbounded states", () => {
  const header = {
    protocol: "tinta-host-1",
    documentId: "a".repeat(32),
    capability: "b".repeat(32),
    requestId: 1,
    sourceRevision: 1,
  };
  expect(base(header)).toBe(true);
  expect(base({ ...header, capability: "short" })).toBe(false);
  expect(base({ ...header, requestId: -1 })).toBe(false);
  expect(controls({ value: Infinity })).toBe(false);
  expect(controls(JSON.parse('{"__proto__":1}'))).toBe(false);
  expect(exact({ kind: "reset", fetch: "https://example.com" }, ["kind"])).toBe(
    false,
  );
});
test("profile and filename operations do not infer executable source", () => {
  expect(profileFor("notes.md")).toBe("markdown");
  expect(profileFor("notes.bin")).toBeUndefined();
  expect(safeFilename("../a:b?.tinta")).toBe(".._a_b_.tinta");
});
for (const [name, source] of Object.entries(snippets))
  test(`complete snippet ${name}`, () => {
    program(source);
  });

describe("compiler transport and watchdog", () => {
  test("ignores stale responses, terminates timeouts and preserves requested source", async () => {
    const { vi } = await import("vitest");
    const { CompilerHost } =
      await import("../../apps/studio/dist/compiler-host.js");
    const workers = [];
    class FakeWorker {
      constructor() {
        workers.push(this);
      }

      postMessage(value) {
        this.request = value;
      }

      terminate() {
        this.terminated = true;
      }
    }
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const results = [];
    try {
      const host = new CompilerHost("trusted runtime", (result) =>
        results.push(result),
      );
      host.compile("# First", "tinta", 1);
      const old = workers[0];
      host.compile("# Second", "tinta", 2);
      expect(old.terminated).toBe(true);
      old.onmessage({
        data: { ...old.request, kind: "rejected", diagnostics: [] },
      });
      expect(host.staleResponses).toBe(1);
      expect(results).toEqual([]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(results).toEqual([]);
      expect(workers[1].terminated).not.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(workers[1].terminated).toBe(true);
      expect(workers[1].request.source).toBe("# Second");
      expect(results[0].diagnostics[0].code).toBe("E_WORKER_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1);
      expect(results).toHaveLength(1);
      host.compile("# Retry", "tinta", 3);
      workers[2].onmessage({ data: { arbitrary: "fetch" } });
      expect(workers[2].terminated).toBe(true);
      expect(results[1].diagnostics[0].code).toBe("E_PROTOCOL");
      host.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("file write acknowledgements", () => {
  test("reports Saved only after close and aborts a failed writer", async () => {
    const { vi } = await import("vitest");
    const { saveFile } = await import("../../apps/studio/dist/files.js");
    const calls = [];
    const writer = {
      write: async (bytes) => {
        calls.push(["write", [...bytes]]);
      },
      close: async () => {
        calls.push(["close"]);
      },
      abort: async () => {
        calls.push(["abort"]);
      },
    };
    vi.stubGlobal("window", {
      showSaveFilePicker: async () => ({ createWritable: async () => writer }),
    });
    try {
      expect(
        await saveFile(new Uint8Array([65]), "draft.tinta", "text/plain", true),
      ).toBe("Saved");
      expect(calls).toEqual([["write", [65]], ["close"]]);
      writer.close = async () => {
        throw new Error("Permission revoked");
      };
      await expect(
        saveFile(new Uint8Array([66]), "draft.tinta", "text/plain", true),
      ).rejects.toThrow("Permission revoked");
      expect(calls.at(-1)).toEqual(["abort"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

test("source highlight ranges reject malformed worker presentation data", async () => {
  const { highlights } =
    await import("../../apps/studio/dist/compiler-host.js");
  expect(highlights([{ from: 0, to: 5 }], 5)).toBe(true);
  for (const value of [
    null,
    [{ from: -1, to: 5 }],
    [{ from: 0, to: 6 }],
    [{ from: 3, to: 3 }],
    [{ from: 0.5, to: 5 }],
    [{ from: 0, to: NaN }],
    [{ from: 0, to: 5, html: "unsafe" }],
    Array.from({ length: 100001 }, () => ({ from: 0, to: 1 })),
  ])
    expect(highlights(value, 5)).toBe(false);
});

test("recovery retains clean and changed state without accepting unknown metadata", async () => {
  const { validateRecovery } =
    await import("../../apps/studio/dist/recovery.js");
  const copy = {
    id: "new",
    edited: 1,
    source: "",
    filename: "untitled.tinta",
    profile: "tinta",
    assets: [],
  };
  expect(validateRecovery({ ...copy, changed: false }).changed).toBe(false);
  expect(validateRecovery({ ...copy, changed: true }).changed).toBe(true);
  expect(validateRecovery(copy).changed).toBeUndefined();
  expect(() => validateRecovery({ ...copy, changed: "false" })).toThrow();
  expect(() => validateRecovery({ ...copy, checkpoint: "hidden" })).toThrow();
});
