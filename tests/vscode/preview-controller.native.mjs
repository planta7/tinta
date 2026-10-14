import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { PreviewController } from "../../apps/vscode/dist/preview.js";
import { preparePreview } from "../../packages/language-service/dist/index.js";
import { hash, encodeUtf8 } from "../../packages/types/dist/common.js";

const io = vi.hoisted(() => ({
  bytes: new TextEncoder().encode("# Source"),
  fail: false,
  pending: undefined,
  reads: 0,
}));
vi.mock("@tinta-lang/local-files", () => ({
  readOpenedSource: async () => {
    io.reads++;
    await io.pending;
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
  await vi.waitFor(() => expect(state.panel.title).toBe("tinta Preview"));
};
beforeEach(() => {
  io.fail = false;
  io.pending = undefined;
  io.reads = 0;
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
  it("switches source, split and preview without closing the source", async () => {
    const doc = document();
    await controller.open(doc, true);
    vscode.window.activeTextEditor = { document: doc, viewColumn: 2 };
    await vscode.handlers["tinta.showPreview"]();
    const state = controller.panels.get(doc);
    expect(vscode.window.createWebviewPanel.mock.calls[0][2]).toBe(2);
    const sourceOptions = {
      viewColumn: 2,
      preserveFocus: false,
      preview: false,
    };
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      doc,
      sourceOptions,
    );
    await ready(state);
    const snapshot = state.source;
    state.panel.active = true;
    vscode.window.activeTextEditor = undefined;
    await vscode.handlers["tinta.openPreview"]();
    expect(state.panel.reveal).toHaveBeenLastCalledWith(
      vscode.ViewColumn.Beside,
      true,
    );
    await vscode.handlers["tinta.showSource"]();
    expect(state.panel.reveal).toHaveBeenLastCalledWith(2, true);
    expect(vscode.window.showTextDocument).toHaveBeenLastCalledWith(
      doc,
      sourceOptions,
    );
    await vscode.handlers["tinta.showPreview"]();
    expect(state.panel.reveal).toHaveBeenLastCalledWith(2, false);
    expect(state.panel.dispose).not.toHaveBeenCalled();
    expect(controller.sources.get(doc).snapshot).toBe(snapshot);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("uses the toolbar resource instead of another active document", async () => {
    const selected = document("# Selected");
    const other = document("# Other");
    other.uri = { scheme: "untitled", toString: () => "untitled:other" };
    await controller.open(selected, true);
    await controller.open(other, true);
    vscode.workspace.textDocuments = [selected, other];
    vscode.window.activeTextEditor = { document: other, viewColumn: 1 };
    await vscode.handlers["tinta.showPreview"](selected.uri);
    expect(controller.panels.has(selected)).toBe(true);
    expect(controller.panels.has(other)).toBe(false);
    await vscode.handlers["tinta.showSource"](selected.uri);
    expect(vscode.window.showTextDocument.mock.lastCall[0]).toBe(selected);
  });

  it("selects the active preview before text in another group", async () => {
    const doc = document();
    await controller.open(doc, true);
    vscode.window.activeTextEditor = { document: doc, viewColumn: 1 };
    await controller.show();
    const state = controller.panels.get(doc);
    state.panel.active = true;
    vscode.window.activeTextEditor = { document: document("# Other") };
    await vscode.handlers["tinta.showPreview"]({
      scheme: "webview-panel",
      toString: () => "webview-panel:opaque-native-resource",
    });
    expect(state.panel.reveal).toHaveBeenLastCalledWith(1, false);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    state.panel.active = false;
    await vscode.handlers["tinta.openPreview"]({
      scheme: "webview-panel",
      toString: () => "webview-panel:foreign-resource",
    });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("keeps source navigation available when verification fails", async () => {
    const doc = { ...document("Dirty", "file"), isDirty: true };
    await controller.open(doc, false);
    vscode.window.activeTextEditor = { document: doc, viewColumn: 1 };
    await vscode.handlers["tinta.showPreview"]();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    await vscode.handlers["tinta.showSource"]();
    expect(vscode.window.showTextDocument.mock.lastCall[0]).toBe(doc);
  });

  it("ignores closed toolbar resources and unsupported Markdown", async () => {
    const markdown = { ...document(), languageId: "markdown" };
    vscode.workspace.textDocuments = [markdown];
    vscode.window.activeTextEditor = { document: markdown };
    for (const command of [
      "tinta.showSource",
      "tinta.openPreview",
      "tinta.showPreview",
    ]) {
      await vscode.handlers[command](markdown.uri);
      await vscode.handlers[command]({
        scheme: "file",
        toString: () => "file:closed",
      });
    }
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("does not open preview if source closes during a view switch", async () => {
    const doc = document();
    await controller.open(doc, true);
    vscode.window.activeTextEditor = { document: doc, viewColumn: 1 };
    vscode.window.showTextDocument.mockImplementationOnce(async () => {
      controller.close(doc);
      doc.isClosed = true;
    });
    await vscode.handlers["tinta.showPreview"]();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it.each(["source", "preview"])(
    "waits for the opening file verification before serving %s",
    async (operation) => {
      let release;
      io.pending = new Promise((resolve) => {
        release = resolve;
      });
      const doc = document("# Source", "file");
      vscode.handlers.open(doc);
      vscode.window.activeTextEditor = { document: doc };
      let completed = false;
      const result = (
        operation === "source" ? controller.source(doc) : controller.show()
      ).then((value) => {
        completed = true;
        return value;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(io.reads).toBe(1);
      release();
      const value = await result;
      if (operation === "source") expect(value.text).toBe("# Source");
      else expect(controller.panels.has(doc)).toBe(true);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(io.reads).toBe(1);
    },
  );

  it.each(["changed", "closed", "failed"])(
    "rejects a %s document after pending verification settles",
    async (outcome) => {
      let release;
      io.pending = new Promise((resolve) => {
        release = resolve;
      });
      const doc = document("# Source", "file");
      vscode.handlers.open(doc);
      const result = controller.source(doc);
      if (outcome === "changed") doc.version++;
      else if (outcome === "closed") vscode.handlers.close(doc);
      else io.fail = true;
      const rejected = expect(result).rejects.toThrow("verification");
      release();
      await rejected;
      expect(controller.panels.size).toBe(0);
      expect(io.reads).toBe(1);
    },
  );

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
    await vi.waitFor(() => expect(state.panel.title).toBe("tinta Preview"));
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

describe("preview file-workflow revisions", () => {
  it("supplies verified snapshots, adopts bundle bytes and validates resource revisions", async () => {
    const doc = document("# Source", "file");
    const source = await controller.source(doc);
    expect(controller.matches(doc, source)).toBe(true);
    controller.resources(doc, new Map(), 1);
    vscode.window.activeTextEditor = { document: doc };
    await controller.show();
    const state = controller.panels.get(doc);
    await ready(state);
    expect(state.assetRevision).toBe(1);
    expect(
      state.panel.webview.postMessage.mock.calls.find(
        ([value]) => value.kind === "load",
      )[0].assetRevision,
    ).toBe(1);
    const old = state.identity;
    await controller.adopt(doc, encodeUtf8("# Source"));
    expect(controller.panels.size).toBe(0);
    expect((await controller.source(doc)).identity.documentInstance).not.toBe(
      old.source.documentInstance,
    );
    expect(controller.matches(doc, source)).toBe(false);
    const mixed = document("A\nB");
    await controller.adopt(mixed, encodeUtf8("A\rB"));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Native Save"),
    );
    doc.version++;
    await expect(controller.source(doc)).rejects.toThrow();
    controller.close(doc);
    expect(() => controller.resources(doc, new Map(), 2)).toThrow();
  });

  it("acquires current answers only through a matched get-state reply and invalidates reset", async () => {
    const doc = document();
    await controller.open(doc, true);
    const source = await controller.source(doc);
    await expect(controller.reading(doc, source)).rejects.toThrow("matching");
    vscode.window.activeTextEditor = { document: doc };
    await controller.show();
    const state = controller.panels.get(doc);
    await ready(state);
    state.panel.webview.postMessage.mockImplementation(async (value) => {
      if (value.kind === "get-state" || value.kind === "reset")
        queueMicrotask(() =>
          controller.receive(state, {
            ...state.identity,
            kind: "state",
            controls: {},
            sessionRevision: 0,
            assetRevision: 0,
          }),
        );
      return true;
    });
    const reading = await controller.reading(doc, source);
    expect(reading.controls).toEqual({});
    expect(reading.current()).toBe(true);
    vscode.window.activeTextEditor = undefined;
    state.panel.active = true;
    await vscode.handlers["tinta.resetReading"]();
    await vi.waitFor(() => expect(state.enabled).toBe(true));
    expect(reading.current()).toBe(false);
    state.panel.webview.postMessage.mockResolvedValue(true);
    vi.useFakeTimers();
    const pending = controller.reading(doc, source);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(3001);
    await rejected;
    state.enabled = false;
    controller.reset();
  });
});
