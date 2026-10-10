import { test, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diagnostic,
  identifyInternalDiagnostic,
} from "../../packages/types/dist/common.js";
import { CompilerHost } from "../../apps/studio/dist/compiler-host.js";
import { run } from "../../packages/cli/dist/index.js";

const privateText = "private source and exception stack";
const incident = /^[a-f0-9-]{32,36}$/;

afterEach(() => vi.unstubAllGlobals());

test("incident decoration is pure and leaves ordinary diagnostics untouched", () => {
  const createId = vi.fn(() => "a".repeat(32));
  const ordinary = diagnostic("E_TYPE", "Expected a number.");
  expect(identifyInternalDiagnostic(ordinary, createId)).toBe(ordinary);
  expect(createId).not.toHaveBeenCalled();
  const internal = diagnostic("E_INTERNAL", privateText);
  const result = identifyInternalDiagnostic(internal, createId);
  expect(result.details.incidentId).toBe("a".repeat(32));
  expect(result.message).toContain(result.details.incidentId);
  expect(JSON.stringify(result)).not.toContain(privateText);
  expect(internal.message).toBe(privateText);
  expect(internal.details).toBeUndefined();
});

test("compiler startup faults expose distinct incidents without exception contents", () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error(privateText);
      }
    },
  );
  const observed = [];
  const host = new CompilerHost("trusted", (result) => observed.push(result));
  host.compile("# Kept source", "tinta", 1);
  host.compile("# Kept source", "tinta", 2);
  host.stop();
  expect(observed.map((item) => item.revision)).toEqual([1, 2]);
  const ids = observed.map(({ diagnostics }) => {
    expect(diagnostics[0].code).toBe("E_INTERNAL");
    expect(diagnostics[0].message).toContain("source is still available");
    const id = diagnostics[0].details.incidentId;
    expect(id).toMatch(incident);
    expect(diagnostics[0].message).toContain(id);
    return id;
  });
  expect(new Set(ids).size).toBe(2);
  expect(JSON.stringify(observed)).not.toContain(privateText);
});

test("compiler runtime and returned internal faults identify incidents and preserve revision", () => {
  const workers = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        workers.push(this);
      }
      postMessage(value) {
        this.request = value;
      }
      terminate() {
        this.terminated = true;
      }
    },
  );
  const results = [];
  const host = new CompilerHost("trusted", (result) => results.push(result));
  try {
    host.compile("# Retained", "tinta", 7);
    workers[0].onerror({ message: privateText });
    expect(workers[0].terminated).toBe(true);
    host.compile("# Retained", "tinta", 8);
    const { source, profile, uri, ...header } = workers[1].request;
    expect(source).toBe("# Retained");
    expect(profile).toBe("tinta");
    expect(uri).toBe("tinta:/document.tinta");
    workers[1].onmessage({
      data: {
        ...header,
        kind: "rejected",
        diagnostics: [diagnostic("E_INTERNAL", privateText)],
      },
    });
    expect(workers[1].terminated).toBe(true);
    expect(results.map((item) => item.revision)).toEqual([7, 8]);
    for (const result of results) {
      const item = result.diagnostics[0];
      expect(item.details.incidentId).toMatch(incident);
      expect(item.message).toContain(item.details.incidentId);
    }
    expect(JSON.stringify(results)).not.toContain(privateText);
  } finally {
    host.stop();
  }
});

test("CLI internal incidents are visible in JSON and text without overwriting files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinta-incident-"));
  const input = join(directory, "source.tinta");
  const output = join(directory, "output.html");
  try {
    await writeFile(input, "# Retained source\n");
    await writeFile(output, "retained output");
    const signal = {
      aborted: false,
      throwIfAborted() {
        throw new Error(privateText);
      },
    };
    const args = [
      "build",
      input,
      "--format",
      "static",
      "--output",
      output,
      "--force",
    ];
    const structured = await run([...args, "--json"], signal);
    const human = await run(args, signal);
    expect(structured.exitCode).toBe(4);
    expect(human.exitCode).toBe(4);
    const result = JSON.parse(structured.stdout);
    expect(result.ok).toBe(false);
    expect(result.artifacts).toEqual([]);
    const item = result.diagnostics.find((d) => d.code === "E_INTERNAL");
    expect(item.details.incidentId).toMatch(incident);
    expect(item.message).toContain(item.details.incidentId);
    expect(human.stderr).toMatch(/E_INTERNAL: .*Incident: [a-f0-9-]{36}\./);
    expect(human.stdout).toBe("");
    expect(structured.stdout + human.stderr).not.toContain(privateText);
    expect(await readFile(input, "utf8")).toBe("# Retained source\n");
    expect(await readFile(output, "utf8")).toBe("retained output");
    const ordinary = await run(["invalid-command", "--json"]);
    expect(ordinary.exitCode).toBe(2);
    expect(ordinary.stdout).not.toContain("incidentId");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
