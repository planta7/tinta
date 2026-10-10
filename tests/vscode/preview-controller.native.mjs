import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { PreviewController } from "../../apps/vscode/dist/preview.js";
import { preparePreview } from "../../packages/language-service/dist/index.js";
import { hash, encodeUtf8 } from "../../packages/types/dist/common.js";

const io = vi.hoisted(() => ({
  bytes: new TextEncoder().encode("# Source"),
  fail: false,
}));
vi.mock("@tinta/local-files", () => ({
  readOpenedSource: async () => {
    if (io.fail) throw new Error("Secret path");
    return io.bytes;
  },
}));
let controller;
let request;
const document = (text = "# Source", scheme = "untitled") => ({
  languageId: "tinta",
  uri: { scheme, fsPath: "/chosen/file", toString: () => `${scheme}:source` },
  version: 1,
  isDirty: false,
  getText: () => text,
});
const createPanel = () => {
  let disposed;
  let message;
  let visible;
  const panel = {
    title: "",
    visible: true,
    webview: {
      html: "",
      postMessage: vi.fn(async (value) => {
        if (value.kind === "load")
          queueMicrotask(() =>
            message({
              protocol: value.protocol,
              panelId: value.panelId,
              capability: value.capability,
              requestId: value.requestId,
              source: value.source,
              kind: "state",
              controls: {},
              sessionRevision: 0,
              assetRevision: value.assetRevision,
            }),
          );
        return true;
      }),
      onDidReceiveMessage: (handler) => {
        message = handler;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: (handler) => {
      disposed = handler;
      return { dispose: vi.fn() };
    },
    onDidChangeViewState: (handler) => {
      visible = handler;
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(() => disposed?.()),
    reveal: vi.fn(),
    emit: (value) => message(value),
    hide: () => {
      panel.visible = false;
      visible({ webviewPanel: panel });
    },
    show: () => {
      panel.visible = true;
      visible({ webviewPanel: panel });
    },
  };
  return panel;
};
const ready = async (state) => {
  controller.receive(state, { ...state.identity, kind: "ready" });
  await vi.waitFor(() => expect(state.panel.title).toBe("Tinta Preview"));
};
beforeEach(() => {
  io.fail = false;
  io.bytes = encodeUtf8("# Source");
  vscode.workspace.textDocuments = [];
  vscode.window.activeTextEditor = undefined;
  vscode.window.createWebviewPanel = vi.fn(createPanel);
  vscode.window.showTextDocument = vi.fn();
  vscode.window.showWarningMessage.mockReset();
  vscode.workspace.openTextDocument = vi.fn(async ({ content }) =>
    document(content),
  );
  request = vi.fn(async (method, params) =>
    method === "tinta/preview"
      ? JSON.parse(JSON.stringify(preparePreview(params.identity, params.text)))
      : null,
  );
  controller = new PreviewController(request);
});
afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
});

describe("native preview controller boundaries", () => {
  it("binds a panel to verified source and never grants workspace resources", async () => {
    const doc = document();
    await controller.open(doc, true);
    vscode.window.activeTextEditor = { document: doc };
    await controller.show();
    const state = controller.panels.get(doc);
    const options = vscode.window.createWebviewPanel.mock.calls[0][3];
    expect(options.localResourceRoots).toEqual([]);
    expect(options.enableCommandUris).toBe(false);
    expect(state.panel.webview.html).toContain("connect-src 'none'");
    await ready(state);
    expect(state.program.source).toBe("# Source");
    expect(state.source.identity.sourceSha256).toBe(
      hash(encodeUtf8("# Source")),
    );
    expect(state.panel.webview.postMessage.mock.lastCall[0].kind).toBe("load");
    await controller.show();
    expect(state.panel.reveal).toHaveBeenCalled();
    const retired = state.identity;
    const before = state.identity.capability;
    state.panel.hide();
    state.panel.show();
    expect(state.identity.capability).not.toBe(before);
    expect(state.ready).toBe(false);
    controller.receive(state, {
      ...retired,
      kind: "state",
      controls: {},
      sessionRevision: 10,
      assetRevision: 0,
    });
    expect(controller.panels.has(doc)).toBe(true);
    state.panel.dispose();
    expect(controller.panels.size).toBe(0);
  });

  it("rejects unsupported, restored, invalid-encoding and over-capacity sources", async () => {
    await controller.show();
    for (const doc of [
      { ...document(), languageId: "markdown" },
      document("Text", "remote"),
    ]) {
      await controller.open(doc, true);
      expect(controller.sources.has(doc)).toBe(false);
    }
    const restored = { ...document("Dirty", "file"), isDirty: true };
    await controller.open(restored, false);
    vscode.window.activeTextEditor = { document: restored };
    await controller.show();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    io.bytes = Uint8Array.of(0xff);
    const bad = document("�", "file");
    await controller.open(bad, false);
    expect(controller.sources.get(bad).snapshot).toBeUndefined();
    io.fail = true;
    await controller.open(document("Text", "file"), false);
    for (let i = controller.sources.size; i < 32; i++)
      await controller.open(document(), true);
    const extra = document();
    await controller.open(extra, true);
    expect(controller.sources.has(extra)).toBe(false);
  });

  it("retains disabled last-valid source while errors and stale work are pending", async () => {
    const doc = document();
    await controller.open(doc, true);
    vscode.window.activeTextEditor = { document: doc };
    await controller.show();
    const state = controller.panels.get(doc);
    await ready(state);
    doc.version = 2;
    doc.getText = () => "@calc broken = missing";
    controller.change({
      document: doc,
      contentChanges: [{ rangeOffset: 0, rangeLength: 8, text: doc.getText() }],
    });
    expect(state.enabled).toBe(false);
    controller.receive(state, {
      ...state.identity,
      kind: "state",
      controls: {},
      sessionRevision: 999,
      assetRevision: 0,
    });
    expect(state.enabled).toBe(false);
    await vi.waitFor(() =>
      expect(state.panel.title).toContain("Source errors"),
    );
    expect(state.program.source).toBe("# Source");
    const old = state.identity;
    doc.version = 3;
    doc.getText = () => "# Fixed";
    controller.change({
      document: doc,
      contentChanges: [{ rangeOffset: 0, rangeLength: 22, text: "# Fixed" }],
    });
    await vi.waitFor(() => expect(state.panel.title).toBe("Tinta Preview"));
    controller.receive(state, {
      ...old,
      kind: "state",
      controls: {},
      sessionRevision: 10,
      assetRevision: 0,
    });
    expect(controller.panels.has(doc)).toBe(true);
    controller.receive(state, {
      ...state.identity,
      kind: "state",
      controls: {},
      sessionRevision: 1,
      assetRevision: 0,
    });
    expect(state.sessionRevision).toBe(1);
    controller.receive(state, {
      ...state.identity,
      kind: "state",
      controls: {},
      sessionRevision: 1,
      assetRevision: 0,
    });
    expect(state.sessionRevision).toBe(1);
    controller.receive(state, {
      ...state.identity,
      capability: "f".repeat(32),
      kind: "state",
      controls: {},
      sessionRevision: 2,
      assetRevision: 0,
    });
    expect(controller.panels.size).toBe(0);
  });

  it("invalidates mapping and saved-byte mismatches without writing the original", async () => {
    const doc = document("# Source", "file");
    await controller.open(doc, false);
    await controller.saved(doc);
    expect(controller.sources.get(doc).snapshot).toBeDefined();
    io.bytes = encodeUtf8("# Different");
    await controller.saved(doc);
    expect(controller.sources.get(doc).snapshot).toBeUndefined();
    expect(controller.sources.get(doc).error).toContain("Saved bytes");
    const mixed = document("A\nB", "file");
    io.bytes = encodeUtf8("A\rB");
    await controller.open(mixed, false);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Native Save"),
    );
    mixed.version++;
    mixed.getText = () => "C\nB";
    controller.change({
      document: mixed,
      contentChanges: [{ rangeOffset: 0, rangeLength: 1, text: "C" }],
    });
    expect(controller.sources.get(mixed).snapshot).toBeUndefined();
  });

  it("creates a separately approved LF copy and honors cancellation", async () => {
    await controller.copy();
    const doc = document("A\r\nB\rC");
    vscode.window.activeTextEditor = { document: doc };
    await controller.copy();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    vscode.window.showWarningMessage.mockResolvedValue("Create Copy");
    await controller.copy();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
      language: "tinta",
      content: "A\nB\nC",
    });
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    expect(doc.getText()).toBe("A\r\nB\rC");
  });
});
