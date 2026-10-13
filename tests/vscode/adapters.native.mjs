import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { connection, handlers as server } from "vscode-languageserver/node";
import { EventEmitter } from "node:events";
import { analyze } from "../../packages/language-service/dist/index.js";
import { authoring } from "../../packages/language-server/dist/authoring.js";
import { activate, deactivate } from "../../apps/vscode/dist/extension.js";

const workers = vi.hoisted(() => ({ instances: [], port: null }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    requests = [];
    constructor(url) {
      super();
      this.url = url;
      workers.instances.push(this);
    }
    postMessage(request) {
      this.requests.push(request);
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return {
    Worker,
    get parentPort() {
      return workers.port;
    },
  };
});

const context = () => ({
  subscriptions: [],
  asAbsolutePath: (path) => `/extension/${path}`,
});
const document = (
  text = "Text",
  languageId = "tinta",
  scheme = "untitled",
) => ({
  languageId,
  version: 1,
  getText: () => text,
  uri: { scheme, toString: () => `${scheme}:test` },
});

beforeEach(() => {
  vi.clearAllMocks();
  vscode.env.remoteName = undefined;
  vscode.env.uiKind = 1;
  vscode.workspace.workspaceFolders = [];
  vscode.workspace.textDocuments = [];
  vscode.window.activeTextEditor = undefined;
  vscode.window.tabGroups.all = [];
  LanguageClient.failStart = false;
  LanguageClient.instances.length = 0;
  workers.instances.length = 0;
});
afterEach(async () => {
  await deactivate();
  if (server.shutdown) server.shutdown();
  vi.useRealTimers();
});

describe("native activation and client boundaries", () => {
  for (const host of ["remote", "web", "virtual"]) {
    it(`rejects ${host} before starting a process`, async () => {
      if (host === "remote") vscode.env.remoteName = "ssh-remote";
      if (host === "web") vscode.env.uiKind = 2;
      if (host === "virtual")
        vscode.workspace.workspaceFolders = [{ uri: { scheme: "remote" } }];
      await activate(context());
      expect(LanguageClient.instances).toHaveLength(0);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
    });
  }

  it("starts only the fixed bundled IPC module and redacts all SDK traces", async () => {
    await activate(context());
    const client = LanguageClient.instances[0];
    expect(client.server).toEqual({
      module: "/extension/dist/server.mjs",
      transport: 1,
      options: { execArgv: [] },
    });
    const output = client.options.outputChannel;
    for (const method of [
      "append",
      "appendLine",
      "replace",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
    ])
      output[method]("SECRET SOURCE");
    output.show();
    expect(output.name).toBe("tinta");
    expect(vscode.output.show).toHaveBeenCalledOnce();
    expect(vscode.output.error.mock.calls[0][0]).toMatch(
      /Incident: [a-f0-9]{32}/,
    );
    expect(vscode.output.error.mock.calls[0][0]).not.toContain("SECRET");
    expect(vscode.status.hide).toHaveBeenCalled();
  });

  it("checks only supported active buffers and keeps disk/assets unverified", async () => {
    await activate(context());
    const client = LanguageClient.instances[0];
    await vscode.handlers.check();
    vscode.window.activeTextEditor = { document: document("text", "markdown") };
    await vscode.handlers.check();
    vscode.window.activeTextEditor = {
      document: document("text", "tinta", "remote"),
    };
    await vscode.handlers.check();
    expect(client.sendRequest).not.toHaveBeenCalled();
    vscode.window.activeTextEditor = { document: document() };
    vscode.handlers.active();
    await vscode.handlers.check();
    expect(client.sendRequest).toHaveBeenCalledWith("tinta/check", {
      uri: "untitled:test",
      version: 1,
      text: "Text",
    });
    expect(vscode.status.tooltip).toContain("unverified");
    client.notification({ uri: "untitled:other", version: 1, source: "valid" });
    client.notification({ uri: "untitled:test", version: 2, source: "valid" });
    expect(vscode.status.text).toBe("tinta: source only");
    for (const [source, text] of [
      ["valid", "tinta: source valid"],
      ["invalid", "tinta: source errors"],
      ["capacity", "tinta: analysis limit reached; try Check again"],
    ]) {
      client.notification({ uri: "untitled:test", version: 1, source });
      expect(vscode.status.text).toBe(text);
    }
    const next = vi.fn();
    await client.options.middleware.didOpen(document(), next);
    await client.options.middleware.didChange({ document: document() }, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("bounds synchronization and Check without transmitting oversized buffers", async () => {
    await activate(context());
    const client = LanguageClient.instances[0];
    const source = document("x".repeat(2097153));
    const next = vi.fn();
    await client.options.middleware.didOpen(source, next);
    await client.options.middleware.didChange({ document: source }, next);
    vscode.window.activeTextEditor = { document: source };
    await vscode.handlers.check();
    expect(next).not.toHaveBeenCalled();
    expect(client.sendRequest).not.toHaveBeenCalled();
    expect(client.diagnostics.set.mock.calls[0][1][0].code).toBe("E_LIMIT");
  });

  it("closes only the last tab and resynchronizes reopened cached models", async () => {
    await activate(context());
    const client = LanguageClient.instances[0];
    const source = document();
    const tab = { input: new vscode.TabInputText(source.uri) };
    vscode.workspace.textDocuments = [source];
    vscode.window.tabGroups.all = [{ tabs: [tab] }];
    vscode.handlers.tabs({
      closed: [tab, { input: {} }],
      opened: [{ input: {} }, tab],
    });
    expect(client.diagnostics.delete).not.toHaveBeenCalled();
    expect(client.sendRequest).toHaveBeenCalledOnce();
    vscode.window.tabGroups.all = [];
    vscode.handlers.tabs({ closed: [tab], opened: [] });
    expect(client.diagnostics.delete).toHaveBeenCalledWith(source.uri);
    expect(client.sendNotification).toHaveBeenCalledWith("tinta/close", {
      uri: "untitled:test",
    });
    vscode.workspace.textDocuments = [document("x".repeat(2097153))];
    vscode.handlers.tabs({ closed: [], opened: [tab] });
    expect(client.sendRequest).toHaveBeenCalledOnce();
    vscode.workspace.textDocuments = [];
    vscode.handlers.tabs({ closed: [], opened: [tab] });
  });

  it("reports startup failure with an opaque incident", async () => {
    LanguageClient.failStart = true;
    await activate(context());
    const message = vscode.window.showErrorMessage.mock.calls[0][0];
    expect(message).toMatch(/Incident: [a-f0-9]{32}/);
    expect(message).not.toContain("SECRET");
  });
});

it("dispatches full UTF-16 LSP synchronization, diagnostics, tokens, folding and capacity", async () => {
  vi.useFakeTimers();
  await import("../../packages/language-server/dist/server.js");
  expect(
    server.initialize({ capabilities: {} }).capabilities.positionEncoding,
  ).toBe("utf-16");
  expect(() =>
    server.initialize({
      capabilities: { general: { positionEncodings: ["utf-8"] } },
    }),
  ).toThrow("UTF-16");
  expect(
    server.initialize({
      capabilities: { general: { positionEncodings: ["utf-16"] } },
    }).capabilities.textDocumentSync,
  ).toBe(1);
  const textDocument = {
    uri: "untitled:server",
    version: 1,
    languageId: "tinta",
    text: "@when true\n{{ missing }}\n@end\n",
  };
  server.open({ textDocument: { ...textDocument, languageId: "markdown" } });
  server.open({ textDocument });
  server["tinta/check"](textDocument);
  expect(workers.instances).toHaveLength(1);
  const worker = workers.instances[0];
  const request = worker.requests[0];
  worker.emit("message", {
    request,
    result: analyze(
      { uri: request.uri, profile: "tinta", text: request.text },
      {
        documentInstance: request.instance,
        editorVersion: 1,
        sourceRevision: 1,
      },
    ),
  });
  expect(
    connection.sendDiagnostics.mock.calls.at(-1)[0].diagnostics[0].code,
  ).toBe("E_NAME_UNKNOWN");
  expect(server.tokens({ textDocument }).data.length).toBeGreaterThan(0);
  expect(server.folding({ textDocument })).toEqual([
    { startLine: 0, endLine: 2 },
  ]);
  const params = {
    textDocument,
    position: { line: 0, character: 2 },
    context: { includeDeclaration: true },
  };
  const token = { isCancellationRequested: false };
  for (const kind of [
    "completion",
    "hover",
    "signature",
    "definition",
    "references",
    "symbols",
  ]) {
    const pending = server[kind](params, token);
    const current = worker.requests.at(-1);
    expect(current.query.params.kind).toBe(kind);
    const result = analyze(
      { uri: current.uri, profile: "tinta", text: current.text },
      {
        documentInstance: current.instance,
        editorVersion: current.version,
        sourceRevision: current.version,
      },
    );
    const response = authoring(result.value, current.query.params);
    worker.emit("message", { request: current, result, authoring: response });
    expect(await pending).toEqual(response);
  }
  expect(
    await server.hover(params, { isCancellationRequested: true }),
  ).toBeNull();
  const cancelled = { isCancellationRequested: false };
  const pending = server.symbols(params, cancelled);
  cancelled.isCancellationRequested = true;
  const current = worker.requests.at(-1);
  worker.emit("message", {
    request: current,
    result: analyze(
      { uri: current.uri, profile: "tinta", text: current.text },
      {
        documentInstance: current.instance,
        editorVersion: current.version,
        sourceRevision: current.version,
      },
    ),
    authoring: [],
  });
  expect(await pending).toBeNull();
  server.change({
    textDocument: { ...textDocument, version: 2 },
    contentChanges: [{ range: {}, text: "ignored" }],
  });
  server.change({
    textDocument: { ...textDocument, version: 2 },
    contentChanges: [{ text: "Text" }],
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(worker.requests.at(-1).version).toBe(2);
  server.close({ textDocument });
  expect(connection.sendDiagnostics.mock.calls.at(-1)[0].diagnostics).toEqual(
    [],
  );
  expect(server.tokens({ textDocument }).data).toEqual([]);
  expect(server.folding({ textDocument })).toEqual([]);
  server["tinta/check"](textDocument);
  server["tinta/close"]({ uri: textDocument.uri });
  for (let index = 0; index < 33; index++)
    server.open({
      textDocument: { ...textDocument, uri: `untitled:${index}` },
    });
  expect(connection.sendNotification.mock.calls.at(-1)[1].source).toBe(
    "capacity",
  );
  server["tinta/source-limit"]({ uri: textDocument.uri, version: 3 });
  expect(
    connection.sendDiagnostics.mock.calls.at(-1)[0].diagnostics[0].code,
  ).toBe("E_LIMIT");
  server.shutdown();
  server.exit();
});

it("runs the worker on supplied text only and refuses a missing port", async () => {
  const port = new EventEmitter();
  port.postMessage = vi.fn();
  workers.port = port;
  const { startWorker } =
    await import("../../packages/language-server/dist/worker.js");
  expect(() => startWorker(null)).toThrow("worker port");
  port.emit("message", {
    uri: "untitled:test",
    version: 1,
    instance: "a".repeat(32),
    text: "@let n = 1\n",
  });
  expect(port.postMessage.mock.calls[0][0].result.value.validity).toBe("valid");
  const base = {
    uri: "untitled:test",
    version: 1,
    instance: "a".repeat(32),
    text: "@let n = 1\n",
    query: { id: 1, params: { kind: "symbols" } },
  };
  port.emit("message", base);
  expect(port.postMessage.mock.calls.at(-1)[0].authoring[0].name).toBe("n");
  expect(port.postMessage.mock.calls.at(-1)[0].result).toBe(
    port.postMessage.mock.calls[0][0].result,
  );
  for (const change of [
    { text: "@let other = 1\n" },
    { version: 2 },
    { instance: "b".repeat(32) },
    { uri: "untitled:other" },
    { text: "x".repeat(2097153) },
  ])
    port.emit("message", { ...base, ...change });
  expect(port.postMessage.mock.calls.at(-1)[0].authoring).toBeNull();
  port.emit("message", base);
  expect(port.postMessage.mock.calls.at(-1)[0].authoring[0].name).toBe("n");
  const beforeRelease = port.postMessage.mock.calls.at(-1)[0].result;
  port.emit("message", {
    release: { uri: base.uri, instance: "b".repeat(32) },
  });
  port.emit("message", base);
  expect(port.postMessage.mock.calls.at(-1)[0].result).toBe(beforeRelease);
  port.emit("message", {
    release: { uri: "untitled:other", instance: base.instance },
  });
  port.emit("message", base);
  expect(port.postMessage.mock.calls.at(-1)[0].result).toBe(beforeRelease);
  port.emit("message", { release: { uri: base.uri, instance: base.instance } });
  port.emit("message", base);
  expect(port.postMessage.mock.calls.at(-1)[0].result).not.toBe(beforeRelease);
});
