import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyze } from "../../packages/language-service/dist/index.js";
import { Supervisor } from "../../packages/language-server/dist/supervisor.js";
import {
  diagnosticPresentation,
  semanticTokens,
  foldingRanges,
  position,
  lineStarts,
} from "../../packages/language-server/dist/presentation.js";

const instances = [];
afterEach(() => {
  instances.forEach((supervisor) => supervisor.dispose());
  instances.length = 0;
  vi.useRealTimers();
});

class FakeWorker extends EventEmitter {
  requests = [];
  terminated = false;
  postMessage(request) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
  reply(request = this.requests.at(-1), result) {
    const { uri, instance, version, text } = request;
    this.emit("message", {
      request: { uri, instance, version },
      result:
        result ??
        analyze(
          { uri, profile: "tinta", text },
          {
            documentInstance: instance,
            editorVersion: version,
            sourceRevision: version,
          },
        ),
    });
  }
}

function harness(create) {
  vi.useFakeTimers();
  const workers = [];
  const publish = vi.fn();
  const capacity = vi.fn();
  const supervisor = new Supervisor({
    debounceMs: 200,
    watchdogMs: 3000,
    createWorker: () => {
      const worker = create ? create() : new FakeWorker();
      workers.push(worker);
      return worker;
    },
    publish,
    capacity,
  });
  instances.push(supervisor);
  return { supervisor, workers, publish, capacity };
}

function snapshot(text) {
  return analyze(
    { uri: "untitled:source", profile: "tinta", text },
    {
      documentInstance: "a".repeat(32),
      editorVersion: 1,
      sourceRevision: 1,
    },
  ).value;
}

describe("bounded native analysis supervision", () => {
  it("debounces, coalesces superseded edits and runs explicit Check immediately", async () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "@let n = 1");
    await vi.advanceTimersByTimeAsync(199);
    expect(workers).toHaveLength(0);
    supervisor.update("untitled:a", 2, "@let n = 2");
    supervisor.check("untitled:a");
    expect(workers[0].requests.map((x) => x.version)).toEqual([2]);
    supervisor.check("untitled:a");
    expect(workers[0].requests).toHaveLength(1);
    workers[0].reply();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot("untitled:a").validity).toBe("valid");
  });

  it("terminates synchronous work, ignores late replies and restarts before pending work", async () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "@let n = 1");
    supervisor.check("untitled:a");
    supervisor.update("untitled:b", 1, "{{ missing }}");
    supervisor.check("untitled:b");
    await vi.advanceTimersByTimeAsync(3000);
    expect(workers[0].terminated).toBe(true);
    expect(publish.mock.calls[0][1].diagnostics[0].code).toBe(
      "E_WORKER_TIMEOUT",
    );
    workers[0].reply();
    expect(publish).toHaveBeenCalledTimes(1);
    workers[1].reply();
    expect(publish.mock.calls[1][1].diagnostics[0].code).toBe("E_NAME_UNKNOWN");
    expect(supervisor.snapshot("untitled:b").validity).toBe("invalid");
  });

  it("invalidates active edits and document instances across close/reopen", async () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "{{ missing }}");
    supervisor.check("untitled:a");
    const original = workers[0].requests[0];
    supervisor.update("untitled:a", 2, "Text");
    supervisor.check("untitled:a");
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply(original);
    expect(publish).not.toHaveBeenCalled();
    workers[1].reply();
    supervisor.close("untitled:a");
    expect(supervisor.has("untitled:a")).toBe(false);
    expect(supervisor.snapshot("untitled:a")).toBeUndefined();
    supervisor.update("untitled:a", 1, "Text");
    await vi.advanceTimersByTimeAsync(200);
    expect(workers[1].requests.at(-1).instance).not.toBe(original.instance);
    workers[1].reply(original);
    expect(publish).toHaveBeenCalledTimes(1);
    workers[1].reply();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("ignores mismatched identities and versions on the current worker", () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "Text");
    supervisor.check("untitled:a");
    const request = workers[0].requests[0];
    for (const patch of [
      { uri: "untitled:other" },
      { instance: "b".repeat(32) },
      { version: 99 },
    ])
      workers[0].reply({ ...request, ...patch });
    expect(publish).not.toHaveBeenCalled();
    workers[0].reply();
    workers[0].reply();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  for (const failure of ["error", "exit", "spawn", "post"]) {
    it(`recovers from ${failure} without exposing exception payloads`, async () => {
      let count = 0;
      const { supervisor, workers, publish } = harness(() => {
        if (failure === "spawn" && count++ === 0)
          throw new Error("PRIVATE SOURCE");
        const worker = new FakeWorker();
        if (failure === "post" && count++ === 0)
          worker.postMessage = () => {
            throw new Error("PRIVATE SOURCE");
          };
        return worker;
      });
      supervisor.update("untitled:a", 1, "Text");
      supervisor.check("untitled:a");
      if (["error", "exit"].includes(failure))
        workers[0].emit(failure, new Error("PRIVATE SOURCE"));
      await vi.advanceTimersByTimeAsync(0);
      const item = publish.mock.calls[0][1].diagnostics[0];
      expect(item.code).toBe("E_INTERNAL");
      expect(item.details.incidentId).toMatch(/^[a-f0-9]{32}$/);
      expect(JSON.stringify(item)).not.toContain("PRIVATE SOURCE");
      supervisor.update("untitled:a", 2, "Text");
      supervisor.check("untitled:a");
      workers.at(-1).reply();
      expect(publish.mock.calls.at(-1)[1].snapshot.validity).toBe("valid");
    });
  }

  it("bounds open identities and supports retry after capacity is freed", () => {
    const { supervisor, capacity } = harness();
    for (let index = 0; index < 32; index++)
      expect(supervisor.update(`untitled:${index}`, 1, "Text")).toBe(true);
    expect(supervisor.update("untitled:overflow", 1, "Text")).toBe(false);
    expect(capacity).toHaveBeenCalledWith("untitled:overflow");
    supervisor.close("untitled:0");
    expect(supervisor.update("untitled:overflow", 1, "Text")).toBe(true);
  });

  it("bounds resident source bytes and never analyzes a truncated oversized source", () => {
    const { supervisor, capacity, publish, workers } = harness();
    const text = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 16; index++)
      supervisor.update(`untitled:${index}`, 1, text);
    expect(supervisor.update("untitled:overflow", 1, "x")).toBe(false);
    expect(capacity).toHaveBeenCalledTimes(1);
    supervisor.close("untitled:0");
    supervisor.close("untitled:1");
    expect(supervisor.update("untitled:oversize", 1, text + "x")).toBe(false);
    expect(publish.mock.calls[0][1].diagnostics[0].code).toBe("E_LIMIT");
    supervisor.check("untitled:oversize");
    expect(workers).toHaveLength(0);
  });

  it("evicts snapshots beyond eight entries and releases caches on close", () => {
    const { supervisor, workers } = harness();
    for (let index = 0; index < 10; index++) {
      supervisor.update(`untitled:${index}`, 1, "Text");
      supervisor.check(`untitled:${index}`);
      workers[0].reply();
    }
    expect(supervisor.snapshot("untitled:0")).toBeUndefined();
    expect(supervisor.snapshot("untitled:1")).toBeUndefined();
    expect(supervisor.snapshot("untitled:2")).toBeDefined();
    supervisor.dispose();
    expect(supervisor.snapshot("untitled:2")).toBeUndefined();
    expect(workers[0].terminated).toBe(true);
    expect(supervisor.update("untitled:new", 1, "Text")).toBe(false);
  });

  it("rejects unsupported identities and stale versions", () => {
    const { supervisor } = harness();
    for (const [uri, version] of [
      ["https://example.test/a", 1],
      ["file:" + "a".repeat(4096), 1],
      ["untitled:a", 0],
      ["untitled:a", 1.2],
    ])
      expect(supervisor.update(uri, version, "Text")).toBe(false);
    supervisor.update("untitled:a", 2, "Text");
    expect(supervisor.update("untitled:a", 1, "Old")).toBe(false);
    supervisor.check("untitled:missing");
    supervisor.close("untitled:missing");
  });

  it("rejects malformed worker envelopes without accepting a valid snapshot", () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "Text");
    supervisor.check("untitled:a");
    workers[0].reply(undefined, { ok: true, diagnostics: [], value: {} });
    expect(publish.mock.calls[0][1].diagnostics[0].code).toBe("E_PROTOCOL");
    expect(workers[0].terminated).toBe(true);
  });

  it("handles analysis failure results and decorates internal diagnostics", () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:a", 1, "Text");
    supervisor.check("untitled:a");
    const item = {
      code: "E_INTERNAL",
      message: "private payload",
      severity: "error",
      phase: "host",
      span: {
        uri: "untitled:a",
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 0, line: 1, column: 1 },
      },
    };
    workers[0].reply(undefined, { ok: false, diagnostics: [item] });
    expect(supervisor.snapshot("untitled:a")).toBeUndefined();
    expect(publish.mock.calls[0][1].diagnostics[0].message).not.toContain(
      "private payload",
    );
  });
});

describe("native protocol presentation", () => {
  it("preserves UTF-16, CRLF, lone CR and zero-width diagnostic locations", () => {
    const text = "😀x\r\ny\rz\n";
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 5, 7, 9]);
    expect(position(text, starts, 3)).toEqual({ line: 0, character: 3 });
    expect(position(text, starts, 4)).toEqual({ line: 0, character: 3 });
    expect(position(text, starts, 5)).toEqual({ line: 1, character: 0 });
    expect(position(text, starts, 99)).toEqual({ line: 3, character: 0 });
    expect(position(text, starts, -1)).toEqual({ line: 0, character: 0 });
    const source = snapshot("@let n = 1\n@let n = 2\n");
    const diagnostics = diagnosticPresentation(
      source.sourceText,
      source.diagnostics,
    );
    expect(diagnostics[0].code).toBe("E_NAME_DUPLICATE");
    expect(diagnostics[0].relatedInformation[0].location.range.start.line).toBe(
      0,
    );
    const incomplete = snapshot("{{ 1 + }}");
    expect(
      diagnosticPresentation(incomplete.sourceText, incomplete.diagnostics)[0]
        .range.start.line,
    ).toBe(0);
  });

  it("highlights only parser-authorized contexts and splits multiline tokens", () => {
    const source = snapshot(
      "```tinta\n@let hidden = missing\n```\n<!-- {{ nope }} -->\n@let n = 1\n{{ n }}\n",
    );
    const data = semanticTokens(source);
    let line = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      expect(line).toBeGreaterThanOrEqual(4);
    }
    expect(data.length).toBeGreaterThan(0);
    const span = (start, end) => ({
      uri: "untitled:source",
      start: { offset: start },
      end: { offset: end },
    });
    const synthetic = {
      ...source,
      sourceText: "ab\r\ncd\nef",
      tokens: [
        { kind: "literal", span: span(0, 9) },
        { kind: "literal", span: span(1, 9) },
      ],
    };
    expect(semanticTokens(synthetic)).toEqual([
      0, 0, 2, 4, 0, 1, 0, 2, 4, 0, 1, 0, 2, 4, 0,
    ]);
  });

  it("folds matched parser blocks without scanning literal text", () => {
    const source = snapshot("@when true\nText\n@end\n```\n@when false\n```\n");
    expect(foldingRanges(source)).toEqual([{ startLine: 0, endLine: 2 }]);
    expect(foldingRanges(snapshot("@end\n"))).toEqual([]);
    expect(foldingRanges(snapshot("# One\nText\n# Two\nMore\n"))).toEqual([
      { startLine: 0, endLine: 1 },
      { startLine: 2, endLine: 4 },
    ]);
  });

  it("keeps Markdown fallback and conservative editing settings", () => {
    const manifest = JSON.parse(readFileSync("apps/vscode/package.json"));
    expect(manifest.contributes.languages[0].extensions).toEqual([".tinta"]);
    expect(
      manifest.contributes.configurationDefaults["[tinta]"][
        "editor.autoIndent"
      ],
    ).toBe("keep");
    expect(
      manifest.contributes.configurationDefaults["[tinta]"][
        "editor.wordBasedSuggestions"
      ],
    ).toBe("off");
    expect(
      manifest.contributes.configurationDefaults["[tinta]"][
        "editor.detectIndentation"
      ],
    ).toBe(true);
    const configuration = JSON.parse(
      readFileSync("apps/vscode/language-configuration.json"),
    );
    expect(configuration.comments.blockComment).toEqual(["<!--", "-->"]);
    expect(
      new RegExp(configuration.indentationRules.increaseIndentPattern).test(
        "@when true",
      ),
    ).toBe(false);
  });
});

it("bundled worker agrees with CLI validation under equal source/options", async () => {
  const root = mkdtempSync(join(tmpdir(), "tinta-editor-parity-"));
  const worker = new Worker(resolve("apps/vscode/dist/worker.mjs"));
  try {
    for (const text of [
      "@let n = 1\n{{ n }}\n",
      "😀 {{ missing }}\n",
      "@calc n = 1 / 0\n",
      "@let n = 1\n@let n = 2\n",
    ]) {
      const path = join(root, "source.tinta");
      writeFileSync(path, text);
      let output;
      try {
        output = execFileSync(
          process.execPath,
          ["packages/cli/bin.mjs", "check", path, "--json"],
          { encoding: "utf8" },
        );
      } catch (error) {
        output = error.stdout;
      }
      const cli = JSON.parse(output);
      const reply = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage({
          uri: path,
          instance: "a".repeat(32),
          version: 1,
          text,
        });
      });
      expect(
        reply.result.diagnostics.map((item) => [
          item.code,
          item.message,
          item.span.start.offset,
          item.span.end.offset,
        ]),
      ).toEqual(
        cli.diagnostics.map((item) => [
          item.code,
          item.message,
          item.span.start.offset,
          item.span.end.offset,
        ]),
      );
    }
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["definition", false],
  ["definition", true],
  ["references", false],
  ["references", true],
])(
  "preserves %s with outline requests over IPC (navigation first: %s)",
  async (kind, navigationFirst) => {
    const child = fork(resolve("apps/vscode/dist/server.mjs"), [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const replies = new Map();
    let timer;
    try {
      await new Promise((accept, reject) => {
        timer = setTimeout(
          () => reject(new Error("Missing IPC replies")),
          8000,
        );
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`IPC exited: ${code}`)));
        child.on("message", (message) => {
          if (message.id === 1) {
            const uri = "file:///outline-navigation.tinta";
            child.send({ jsonrpc: "2.0", method: "initialized", params: {} });
            child.send({
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: {
                textDocument: {
                  uri,
                  languageId: "tinta",
                  version: 1,
                  text: "@let amount = 2\n# 😀 Heading\n{{ amount }}",
                },
              },
            });
            const requests = [
              [2, "textDocument/documentSymbol", {}],
              [
                3,
                `textDocument/${kind}`,
                {
                  position: { line: 2, character: 5 },
                  context: { includeDeclaration: true },
                },
              ],
              [4, "textDocument/documentSymbol", {}],
            ];
            if (navigationFirst)
              [requests[0], requests[1]] = [requests[1], requests[0]];
            for (const [id, method, extra] of requests) {
              child.send({
                jsonrpc: "2.0",
                id,
                method,
                params: { textDocument: { uri }, ...extra },
              });
            }
          } else if ([2, 3, 4].includes(message.id)) {
            replies.set(message.id, message.result);
            if (replies.size === 3) accept();
          }
        });
        child.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { processId: process.pid, capabilities: {}, rootUri: null },
        });
      });
      expect(replies.get(2).map((item) => item.name)).toEqual([
        "amount",
        "😀 Heading",
      ]);
      expect(replies.get(4)).toEqual(replies.get(2));
      expect(replies.get(3).map((item) => item.range.start.line)).toEqual(
        kind === "references" ? [0, 2] : [0],
      );
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  },
);

it("shares overlapping symbol requests for the same document version", async () => {
  const { supervisor, workers } = harness();
  supervisor.update("untitled:a", 1, "@let amount = 2");
  const first = supervisor.query("untitled:a", { kind: "symbols" });
  const second = supervisor.query("untitled:a", { kind: "symbols" });
  expect(second).toBe(first);
  expect(workers).toHaveLength(1);
  expect(workers[0].terminated).toBe(false);
  const request = workers[0].requests[0];
  const result = analyze(
    { uri: request.uri, profile: "tinta", text: request.text },
    {
      documentInstance: request.instance,
      editorVersion: request.version,
      sourceRevision: request.version,
    },
  );
  const symbols = [{ name: "amount" }];
  workers[0].emit("message", { request, result, authoring: symbols });
  expect(await first).toEqual(symbols);
  expect(await second).toEqual(symbols);
  const pending = supervisor.query("untitled:a", { kind: "symbols" });
  const duplicate = supervisor.query("untitled:a", { kind: "symbols" });
  supervisor.update("untitled:a", 2, "@let amount = 3");
  expect(await pending).toBeNull();
  expect(await duplicate).toBeNull();
});

it("keeps outline symbols pending when navigation interrupts their analysis", async () => {
  const { supervisor, workers } = harness();
  const uri = "untitled:outline-navigation";
  supervisor.update(uri, 1, "@let amount = 2\n{{ amount }}");
  const outline = supervisor.query(uri, { kind: "symbols" });
  const definition = supervisor.query(uri, {
    kind: "definition",
    position: { line: 1, character: 5 },
  });
  const concurrentOutline = supervisor.query(uri, { kind: "symbols" });
  expect(concurrentOutline).toBe(outline);
  await vi.advanceTimersByTimeAsync(0);
  const worker = workers.at(-1);
  const request = worker.requests.at(-1);
  expect(request.query.params.kind).toBe("definition");
  const result = analyze(
    { uri, profile: "tinta", text: request.text },
    {
      documentInstance: request.instance,
      editorVersion: request.version,
      sourceRevision: request.version,
    },
  );
  const target = [
    {
      uri,
      range: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 11 },
      },
    },
  ];
  worker.emit("message", { request, result, authoring: target });
  expect(await definition).toEqual(target);
  expect((await outline).map((item) => item.name)).toEqual(["amount"]);
  expect(await concurrentOutline).toEqual(await outline);
});

for (const kind of [
  "references",
  "definition",
  "hover",
  "completion",
  "signature",
]) {
  it(`does not cancel pending ${kind} when outline symbols arrive`, async () => {
    const { supervisor, workers } = harness();
    const uri = "untitled:navigation-outline";
    supervisor.update(uri, 1, "@let amount = 2\n{{ amount }}");
    const navigation = supervisor.query(uri, {
      kind,
      position: { line: 1, character: 5 },
      includeDeclaration: true,
    });
    const outline = supervisor.query(uri, { kind: "symbols" });
    const duplicate = supervisor.query(uri, { kind: "symbols" });
    expect(duplicate).toBe(outline);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    const request = workers[0].requests[0];
    const result = analyze(
      { uri, profile: "tinta", text: request.text },
      {
        documentInstance: request.instance,
        editorVersion: request.version,
        sourceRevision: request.version,
      },
    );
    const response = [{ name: "requested result" }];
    workers[0].emit("message", { request, result, authoring: response });
    expect(await navigation).toEqual(response);
    expect((await outline).map((item) => item.name)).toEqual(["amount"]);
    expect(await duplicate).toEqual(await outline);
  });
}

for (const invalidate of ["edit", "close", "timeout", "dispose"]) {
  it(`invalidates retained outline queries on ${invalidate}`, async () => {
    const { supervisor } = harness();
    const uri = "untitled:retained-outline";
    supervisor.update(uri, 1, "@let amount = 2");
    const outline = supervisor.query(uri, { kind: "symbols" });
    const navigation = supervisor.query(uri, {
      kind: "definition",
      position: { line: 0, character: 6 },
    });
    const duplicate = supervisor.query(uri, { kind: "symbols" });
    expect(duplicate).toBe(outline);
    if (invalidate === "edit") supervisor.update(uri, 2, "@let amount = 3");
    else if (invalidate === "close") supervisor.close(uri);
    else if (invalidate === "dispose") supervisor.dispose();
    else await vi.advanceTimersByTimeAsync(3000);
    expect(await outline).toBeNull();
    expect(await duplicate).toBeNull();
    expect(await navigation).toBeNull();
  });
}

it("queries immediately, coalesces requests and releases replies on edits, close and timeout", async () => {
  const { supervisor, workers } = harness();
  expect(
    await supervisor.query("untitled:absent", { kind: "symbols" }),
  ).toBeNull();
  supervisor.update("untitled:a", 1, "@sl");
  const first = supervisor.query("untitled:a", {
    kind: "completion",
    position: { line: 0, character: 3 },
  });
  expect(workers[0].requests[0].query.params.kind).toBe("completion");
  const second = supervisor.query("untitled:a", {
    kind: "completion",
    position: { line: 0, character: 2 },
  });
  expect(await first).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  const request = workers[1].requests[0];
  const result = analyze(
    { uri: request.uri, profile: "tinta", text: request.text },
    {
      documentInstance: request.instance,
      editorVersion: request.version,
      sourceRevision: request.version,
    },
  );
  workers[1].emit("message", {
    request: { ...request, query: { ...request.query, id: 0 } },
    result,
    authoring: [],
  });
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  workers[1].emit("message", { request, result, authoring: [] });
  expect(await second).toEqual([]);
  const changed = supervisor.query("untitled:a", { kind: "symbols" });
  supervisor.update("untitled:a", 2, "Text");
  expect(await changed).toBeNull();
  const closed = supervisor.query("untitled:a", { kind: "symbols" });
  supervisor.close("untitled:a");
  expect(await closed).toBeNull();
  supervisor.update("untitled:b", 1, "Text");
  const timed = supervisor.query("untitled:b", { kind: "symbols" });
  await vi.advanceTimersByTimeAsync(3000);
  expect(await timed).toBeNull();
  supervisor.update("untitled:large", 1, "x".repeat(2097153));
  expect(
    await supervisor.query("untitled:large", { kind: "symbols" }),
  ).toBeNull();
});

for (const active of [false, true]) {
  it(`releases closed worker caches and recovers from release failure (active: ${active})`, async () => {
    const { supervisor, workers, publish } = harness();
    supervisor.update("untitled:cached", 1, "Text");
    supervisor.check("untitled:cached");
    const worker = workers[0];
    worker.reply();
    supervisor.close("untitled:cached");
    expect(worker.requests.at(-1).release.uri).toBe("untitled:cached");

    supervisor.update("untitled:cached", 1, "Text");
    supervisor.check("untitled:cached");
    worker.reply();
    if (active) {
      supervisor.update("untitled:other", 1, "Text");
      supervisor.check("untitled:other");
    }
    worker.postMessage = () => {
      throw new Error("PRIVATE SOURCE");
    };
    supervisor.close("untitled:cached");
    expect(worker.terminated).toBe(true);
    if (active) {
      expect(publish.mock.calls.at(-1)[0].uri).toBe("untitled:other");
      expect(publish.mock.calls.at(-1)[1].diagnostics[0].code).toBe(
        "E_INTERNAL",
      );
      expect(JSON.stringify(publish.mock.calls.at(-1))).not.toContain(
        "PRIVATE SOURCE",
      );
    }
    supervisor.update("untitled:next", 1, "Text");
    supervisor.check("untitled:next");
    await vi.advanceTimersByTimeAsync(0);
    workers[1].reply();
    expect(supervisor.snapshot("untitled:next").validity).toBe("valid");
  });
}
