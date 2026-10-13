import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execute = promisify(execFile);

export async function residentBytes({
  platform = process.platform,
  pid = process.pid,
  env = process.env,
  run = execute,
} = {}) {
  let rows;
  if (platform === "win32") {
    // Worker environment copies are case-sensitive even on Windows.
    const systemRoot = Object.entries(env).find(
      ([name]) => name.toLowerCase() === "systemroot",
    )?.[1];
    assert.ok(systemRoot, "Windows system root is unavailable");
    const command = join(
      systemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const { stdout } = await run(
      command,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize)",
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    const processes = JSON.parse(stdout);
    assert.ok(Array.isArray(processes), "Invalid process memory inventory");
    rows = processes.map((entry) => [
      entry.ProcessId,
      entry.ParentProcessId,
      Number(entry.WorkingSetSize),
    ]);
  } else {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    rows = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [id, parent, kib] = line.trim().split(/\s+/).map(Number);
        return [id, parent, kib * 1024];
      });
  }
  assert.ok(
    rows.some(([id]) => id === pid),
    "Host process is missing",
  );
  const children = new Map();
  for (const [id, parent, bytes] of rows) {
    assert.ok(
      [id, parent, bytes].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
      "Invalid process memory measurement",
    );
    const siblings = children.get(parent) ?? [];
    siblings.push(id);
    children.set(parent, siblings);
  }
  const descendants = new Set([pid]);
  for (const id of descendants)
    for (const child of children.get(id) ?? []) descendants.add(child);
  return rows
    .filter(([id]) => descendants.has(id))
    .reduce((sum, row) => sum + row[2], 0);
}
