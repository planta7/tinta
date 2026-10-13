import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { residentBytes } from "../vscode/resident-memory.mjs";
import {
  runNativeMode,
  runNativeModes,
} from "../../scripts/candidate-native.mjs";

const processes = [
  { ProcessId: 40, ParentProcessId: 30, WorkingSetSize: "4096" },
  { ProcessId: 20, ParentProcessId: 10, WorkingSetSize: "1024" },
  { ProcessId: 30, ParentProcessId: 20, WorkingSetSize: "2048" },
  { ProcessId: 99, ParentProcessId: 1, WorkingSetSize: "8192" },
];

describe("native resident memory measurements", () => {
  it.each(["darwin", "linux", "win32"])(
    "sums the host and descendants on %s",
    async (platform) => {
      const run = vi.fn().mockResolvedValue({
        stdout:
          platform === "win32"
            ? JSON.stringify(processes)
            : " 40 30 4\n20 10 1\n30 20 2\n99 1 8\n",
      });
      expect(
        await residentBytes({
          platform,
          pid: 20,
          env: { SystemRoot: "C:/Windows" },
          run,
        }),
      ).toBe(7168);
      const [command, args] = run.mock.calls[0];
      if (platform === "win32") {
        expect(command).toContain("powershell.exe");
        expect(args.at(-1)).toContain("WorkingSetSize");
      } else expect(command).toBe("ps");
    },
  );
  it("does not block the event loop waiting for the process collector", async () => {
    let complete;
    const run = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const measurement = residentBytes({ platform: "linux", pid: 20, run });
    await new Promise((resolve) => setImmediate(resolve));
    complete({ stdout: "20 10 1" });
    expect(await measurement).toBe(1024);
  });
  it.each(["", "99 1 8", "20 10 NaN", "20 10 -1"])(
    "rejects missing or invalid measurements",
    async (stdout) => {
      await expect(
        residentBytes({
          platform: "linux",
          pid: 20,
          run: async () => ({ stdout }),
        }),
      ).rejects.toThrow();
    },
  );
  it("propagates collector failures instead of passing an unknown RSS", async () => {
    await expect(
      residentBytes({
        run: async () => {
          throw new Error("collector failed");
        },
      }),
    ).rejects.toThrow("collector failed");
  });
});

describe("native failure evidence", () => {
  it.each([false, true])(
    "preserves measured failure and propagates it (offline=%s)",
    (offline) => {
      const root = mkdtempSync(join(tmpdir(), "tinta-native-evidence-"));
      try {
        const result = {
          status: "FAIL",
          performance: { loopMaxMs: 101 },
          completionLatency: {
            samples: [{ totalMs: 88, serverRoundTripMs: 1 }],
          },
        };
        const execute = () => {
          writeFileSync(join(root, "result.json"), JSON.stringify(result));
          const logs = join(root, "portable/user-data/logs/session");
          mkdirSync(logs, { recursive: true });
          writeFileSync(join(logs, "main.log"), "desktop diagnostics");
          writeFileSync(join(root, "ui-request.json"), '{"id":1}');
          throw new Error("host budgets failed");
        };
        const evidence = join(root, "retained.json");
        expect(() =>
          runNativeMode(["fixture"], root, evidence, {
            offline,
            run: execute,
            isolate: execute,
          }),
        ).toThrow("host budgets failed");
        expect(JSON.parse(readFileSync(evidence))).toEqual(result);
        expect(
          readFileSync(`${evidence}.diagnostics/logs/session/main.log`, "utf8"),
        ).toBe("desktop diagnostics");
        expect(
          JSON.parse(readFileSync(`${evidence}.diagnostics/ui-request.json`)),
        ).toEqual({ id: 1 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("independent native checks", () => {
  it("executes offline checks after an earlier failure and still fails the gate", () => {
    const observed = [];
    expect(() =>
      runNativeModes(["performance", "os-offline"], (mode) => {
        observed.push(mode);
        if (mode === "performance") throw new Error("host budgets failed");
      }),
    ).toThrow(AggregateError);
    expect(observed).toEqual(["performance", "os-offline"]);
  });
});
