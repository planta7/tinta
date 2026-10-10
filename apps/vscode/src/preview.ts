import * as vscode from "vscode";
import { createHash, randomBytes } from "node:crypto";
import { readOpenedSource } from "@tinta/local-files";
import { encodeUtf8, limits } from "@tinta/types/common";
import {
  boundedJson,
  sameDocument,
  sameRevision,
  webviewMessage,
  type WebviewIdentity,
} from "@tinta/types/webview";
import type { ProgramIR, Result } from "@tinta/types";
import type { SourceIdentity } from "@tinta/types/editor";
import { acquireSource, editSource, type NativeSource } from "./source.js";
import {
  previewHtml,
  outerCode,
  previewScriptHash,
  previewStyleHash,
} from "./preview-runtime.js";

interface SourceState {
  readonly instance: string;
  snapshot?: NativeSource;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
}
interface PanelState {
  readonly panel: vscode.WebviewPanel;
  readonly document: vscode.TextDocument;
  identity: WebviewIdentity;
  ready: boolean;
  sessionRevision: number;
  generation: number;
  source?: NativeSource;
  program?: ProgramIR;
  enabled: boolean;
  expectedLoad?: number;
  readonly retired: Map<string, string>;
}

type Request = <T>(method: string, params: unknown) => Promise<T>;
const token = () => randomBytes(16).toString("hex");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64");
const style =
  "html,body{height:100%;margin:0}" +
  "body{display:flex;flex-direction:column;color:var(--vscode-foreground);" +
  "background:var(--vscode-editor-background);" +
  "font-family:var(--vscode-font-family)}" +
  "p,details{margin:8px 12px}" +
  "iframe{flex:1;width:100%;border:0;background:white}" +
  "summary{cursor:pointer}" +
  ":focus-visible{outline:2px solid var(--vscode-focusBorder)}";

export class PreviewController implements vscode.Disposable {
  private readonly sources = new Map<vscode.TextDocument, SourceState>();
  private readonly panels = new Map<vscode.TextDocument, PanelState>();
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly request: Request) {
    this.listeners.push(
      vscode.workspace.onDidOpenTextDocument(
        (document) => void this.open(document, true),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => this.change(event)),
      vscode.workspace.onDidSaveTextDocument(
        (document) => void this.saved(document),
      ),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.close(document),
      ),
      vscode.commands.registerCommand("tinta.openPreview", () => this.show()),
      vscode.commands.registerCommand("tinta.previewCopy", () => this.copy()),
    );
    for (const document of vscode.workspace.textDocuments)
      void this.open(document, false);
  }

  private supported(document: vscode.TextDocument): boolean {
    return (
      document.languageId === "tinta" &&
      ["file", "untitled"].includes(document.uri.scheme)
    );
  }

  private async open(
    document: vscode.TextDocument,
    newDocument: boolean,
  ): Promise<void> {
    if (!this.supported(document) || this.sources.has(document)) return;
    if (this.sources.size >= 32) return;
    const state: SourceState = { instance: token(), generation: 0 };
    this.sources.set(document, state);
    const version = document.version;
    const text = document.getText();
    try {
      let bytes: Uint8Array;
      if (document.uri.scheme === "file" && !document.isDirty)
        bytes = await readOpenedSource(document.uri.fsPath);
      else if (
        document.uri.scheme === "untitled" &&
        newDocument &&
        document.version === 1 &&
        !text.includes("\r")
      )
        bytes = encodeUtf8(text);
      else
        throw new Error(
          "Unverified restored or edited buffer. Create a separate UTF-8/LF copy for preview.",
        );
      if (this.sources.get(document) !== state) return;
      if (document.version !== version)
        throw new Error(
          "Source changed during verification. Create a separate UTF-8/LF copy for preview.",
        );
      const total = [...this.sources.values()].reduce(
        (sum, item) =>
          sum + (item.snapshot ? encodeUtf8(item.snapshot.text).length : 0),
        0,
      );
      if (total + bytes.length > 32 * 1024 * 1024)
        throw new Error("Preview source capacity exceeded.");
      state.snapshot = acquireSource(bytes, text, {
        uri: document.uri.toString(),
        documentInstance: state.instance,
        editorVersion: version,
        sourceRevision: 0,
      });
      if (state.snapshot.conversionRequired)
        void vscode.window.showWarningMessage(
          "This source has lone-CR or mixed line endings. Native Save may rewrite them after editing. Create a separate UTF-8/LF copy before previewing edits.",
        );
    } catch {
      if (this.sources.get(document) === state)
        state.error =
          "Source bytes are unverified. Use Tinta: Create UTF-8/LF Copy for Preview; the original is preserved.";
    }
  }

  private change(event: vscode.TextDocumentChangeEvent): void {
    const state = this.sources.get(event.document);
    if (!state) return;
    state.generation++;
    const panel = this.panels.get(event.document);
    if (panel) this.disable(panel, "Checking source");
    if (!event.contentChanges.length) return;
    try {
      if (!state.snapshot) throw new Error("Unverified source.");
      state.snapshot = editSource(
        state.snapshot,
        event.document.version,
        event.document.getText(),
        event.contentChanges,
      );
      const total = [...this.sources.values()].reduce(
        (sum, item) =>
          sum + (item.snapshot ? encodeUtf8(item.snapshot.text).length : 0),
        0,
      );
      if (total > 32 * 1024 * 1024)
        throw new Error("Preview source capacity exceeded.");
      delete state.error;
    } catch {
      delete state.snapshot;
      state.error =
        "Source mapping is unverified or conversion is required. Create a separate UTF-8/LF copy for preview.";
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      delete state.timer;
      if (panel) void this.update(panel);
    }, 200);
  }

  private async saved(document: vscode.TextDocument): Promise<void> {
    const state = this.sources.get(document);
    if (!state || document.uri.scheme !== "file") return;
    const snapshot = state.snapshot;
    const generation = ++state.generation;
    const panel = this.panels.get(document);
    if (panel) this.disable(panel, "Verifying saved source");
    try {
      if (!snapshot) throw new Error("Unverified source.");
      const bytes = await readOpenedSource(document.uri.fsPath);
      if (
        state.generation !== generation ||
        this.sources.get(document) !== state
      )
        return;
      const candidate = acquireSource(
        bytes,
        document.getText(),
        snapshot.identity,
      );
      if (candidate.identity.sourceSha256 !== snapshot.identity.sourceSha256)
        throw new Error("Saved bytes differ from the preview source.");
      state.snapshot = candidate;
    } catch {
      if (state.generation !== generation) return;
      delete state.snapshot;
      state.error =
        "Saved bytes do not match the verified source. Reopen it or create a separate UTF-8/LF copy.";
    }
    if (panel) void this.update(panel);
  }

  release(uri: string): void {
    for (const document of this.sources.keys())
      if (document.uri.toString() === uri) this.close(document);
  }

  private close(document: vscode.TextDocument): void {
    const state = this.sources.get(document);
    if (state?.timer) clearTimeout(state.timer);
    this.sources.delete(document);
    this.panels.get(document)?.panel.dispose();
    this.panels.delete(document);
  }

  private async copy(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !this.supported(document)) return;
    const text = document
      .getText()
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    if (encodeUtf8(text).length > limits.sourceBytes) return;
    const answer = await vscode.window.showWarningMessage(
      "Create a separate UTF-8/LF document from the current editor text? Line endings become LF and the original file remains unchanged. This cannot recover bytes already replaced by native decoding.",
      { modal: true },
      "Create Copy",
    );
    if (answer !== "Create Copy") return;
    const copy = await vscode.workspace.openTextDocument({
      language: "tinta",
      content: text,
    });
    if (!this.sources.has(copy)) await this.open(copy, true);
    await vscode.window.showTextDocument(copy);
  }

  private async show(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !this.supported(document)) return;
    await this.open(document, false);
    const snapshot = this.sources.get(document)?.snapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage(
        this.sources.get(document)?.error ??
          "Source verification is pending. Retry Open Preview.",
      );
      return;
    }
    const existing = this.panels.get(document);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    if (this.panels.size >= 4) {
      void vscode.window.showWarningMessage(
        "At most four Tinta previews may be open.",
      );
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "tinta.preview",
      "Tinta Preview — Checking source",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableCommandUris: false,
        localResourceRoots: [],
        retainContextWhenHidden: false,
      },
    );
    const state: PanelState = {
      panel,
      document,
      identity: {
        protocol: "tinta-vscode-1",
        panelId: token(),
        capability: token(),
        requestId: 0,
        source: snapshot.identity,
      },
      ready: false,
      sessionRevision: -1,
      generation: 0,
      enabled: false,
      retired: new Map(),
    };
    this.panels.set(document, state);
    const messages = panel.webview.onDidReceiveMessage((message: unknown) =>
      this.receive(state, message),
    );
    let wasVisible = panel.visible;
    const visibility = panel.onDidChangeViewState((event) => {
      const visible = event.webviewPanel.visible;
      if (visible && !wasVisible) this.reconstruct(state);
      wasVisible = visible;
    });
    panel.onDidDispose(() => {
      state.generation++;
      messages.dispose();
      visibility.dispose();
      this.panels.delete(document);
      delete state.program;
      delete state.source;
    });
    this.reconstruct(state);
  }

  private reconstruct(state: PanelState): void {
    state.generation++;
    state.ready = false;
    state.enabled = false;
    state.sessionRevision = -1;
    delete state.program;
    delete state.source;
    state.retired.set(state.identity.panelId, state.identity.capability);
    while (state.retired.size > 2)
      state.retired.delete(state.retired.keys().next().value!);
    delete state.expectedLoad;
    state.identity = {
      ...state.identity,
      panelId: token(),
      capability: token(),
      requestId: 0,
    };
    const payload = JSON.stringify({
      identity: state.identity,
      previewHtml,
    }).replace(/</g, "\\u003c");
    const code = `const tintaBootstrap = ${payload};\n${outerCode}`;
    const policy =
      `default-src 'none'; ` +
      `script-src 'sha256-${digest(code)}' 'sha256-${previewScriptHash}'; ` +
      `style-src 'sha256-${digest(style)}' 'sha256-${previewStyleHash}'; ` +
      "img-src data: blob:; frame-src 'self'; connect-src 'none'; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
    state.panel.webview.html =
      '<!doctype html><html lang="en"><head><meta charset="UTF-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
      `<style>${style}</style></head><body>` +
      `<script>${code}</script></body></html>`;
  }

  private receive(state: PanelState, message: unknown): void {
    if (this.panels.get(state.document) !== state) return;
    if (
      webviewMessage(message) &&
      state.retired.get(message.panelId) === message.capability
    )
      return;
    if (
      !webviewMessage(message) ||
      message.panelId !== state.identity.panelId ||
      message.capability !== state.identity.capability ||
      !sameDocument(message.source, state.identity.source) ||
      message.requestId > state.identity.requestId
    ) {
      state.panel.dispose();
      void vscode.window.showErrorMessage(
        "E_PROTOCOL: Invalid preview message. Preview closed.",
      );
      return;
    }
    if (
      message.source.sourceRevision < state.identity.source.sourceRevision &&
      message.source.editorVersion < state.identity.source.editorVersion
    )
      return;
    if (!sameRevision(message.source, state.identity.source)) {
      state.panel.dispose();
      return;
    }
    if (message.kind === "ready" && !state.ready) {
      state.ready = true;
      void this.update(state);
    } else if (message.kind === "state" && state.ready) {
      if (
        message.requestId < state.identity.requestId ||
        message.sessionRevision <= state.sessionRevision
      )
        return;
      if (message.assetRevision !== 0) {
        state.panel.dispose();
        return;
      }
      if (!state.enabled && state.expectedLoad !== message.requestId) return;
      delete state.expectedLoad;
      state.sessionRevision = message.sessionRevision;
      state.enabled = true;
      state.panel.title = "Tinta Preview";
    } else if (message.kind === "diagnostics") {
      state.panel.dispose();
      void vscode.window.showErrorMessage(
        "E_PROTOCOL: Preview could not validate its payload.",
      );
    } else state.panel.dispose();
  }

  private send(
    state: PanelState,
    kind: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (!state.ready) return;
    state.identity = {
      ...state.identity,
      requestId: state.identity.requestId + 1,
    };
    const message = { ...state.identity, kind, ...fields };
    if (!boundedJson(message)) {
      state.enabled = false;
      state.panel.title = "Tinta Preview — Transport capacity exceeded";
      return;
    }
    void state.panel.webview.postMessage(message);
  }

  private disable(state: PanelState, title: string): void {
    state.enabled = false;
    delete state.expectedLoad;
    state.generation++;
    state.panel.title = `Tinta Preview — ${title}`;
    this.send(state, "set-enabled", { enabled: false });
  }

  private async update(state: PanelState): Promise<void> {
    if (!state.ready || this.panels.get(state.document) !== state) return;
    this.disable(state, "Checking source");
    const snapshot = this.sources.get(state.document)?.snapshot;
    if (!snapshot) {
      state.panel.title =
        "Tinta Preview — Source unverified; create a UTF-8/LF copy";
      return;
    }
    const generation = state.generation;
    try {
      // Ensure native synchronization has reached this version before querying.
      await this.request("tinta/check", {
        uri: snapshot.identity.uri,
        version: state.document.version,
        text: state.document.getText(),
      });
      const compiled = await this.request<{
        identity: SourceIdentity;
        result: Result<ProgramIR>;
      } | null>("tinta/preview", {
        identity: snapshot.identity,
        text: snapshot.text,
      });
      if (
        state.generation !== generation ||
        this.panels.get(state.document) !== state ||
        this.sources.get(state.document)?.snapshot !== snapshot
      )
        return;
      if (
        !compiled ||
        !sameRevision(compiled.identity, snapshot.identity) ||
        !compiled.result.ok
      ) {
        state.panel.title =
          "Tinta Preview — Source errors; last valid preview disabled";
        return;
      }
      state.identity = { ...state.identity, source: snapshot.identity };
      state.source = snapshot;
      state.program = compiled.result.value;
      state.sessionRevision = -1;
      state.enabled = false;
      this.send(state, "load", {
        program: compiled.result.value,
        assets: [],
        assetPaths: {},
        baseline: {},
        assetRevision: 0,
      });
      state.expectedLoad = state.identity.requestId;
    } catch {
      if (state.generation !== generation) return;
      state.panel.title = "Tinta Preview — Host failure";
      void vscode.window.showErrorMessage(
        `Preview failed. Incident: ${token()}.`,
      );
    }
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    for (const document of this.sources.keys()) this.close(document);
  }
}
