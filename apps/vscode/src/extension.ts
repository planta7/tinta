import * as vscode from "vscode";
import { FileController } from "./files.js";
import { PreviewController } from "./preview.js";
import { limits } from "@tinta/types/common";
import { randomBytes } from "node:crypto";
import {
  LanguageClient,
  TransportKind,
  RevealOutputChannelOn,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let previews: PreviewController | undefined;
let files: FileController | undefined;

function privateOutput(): vscode.LogOutputChannel {
  const output = vscode.window.createOutputChannel("Tinta", { log: true });
  // SDK tracing must never serialize source buffers, URIs or exception payloads.
  return new Proxy(output, {
    get(target, property) {
      if (
        [
          "append",
          "appendLine",
          "replace",
          "trace",
          "debug",
          "info",
          "warn",
        ].includes(String(property))
      )
        return () => {};
      if (property === "error")
        return () =>
          target.error(
            `Host failure. Incident: ${randomBytes(16).toString("hex")}.`,
          );
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (
    vscode.env.remoteName ||
    vscode.env.uiKind !== vscode.UIKind.Desktop ||
    vscode.workspace.workspaceFolders?.some(
      (folder) => folder.uri.scheme !== "file",
    )
  ) {
    void vscode.window.showWarningMessage(
      "Tinta requires a local VS Code Desktop workspace.",
    );
    return;
  }
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10,
  );
  status.command = "tinta.check";
  status.text = "Tinta: source only";
  status.tooltip =
    "Source diagnostics use editor text. Disk encoding is unverified; assets are not checked.";
  const bounded = (document: vscode.TextDocument): boolean => {
    if (Buffer.byteLength(document.getText(), "utf8") <= limits.sourceBytes)
      return true;
    const item = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      "Source byte limit exceeded.",
      vscode.DiagnosticSeverity.Error,
    );
    item.code = "E_LIMIT";
    item.source = "tinta";
    void client?.sendNotification("tinta/source-limit", {
      uri: document.uri.toString(),
      version: document.version,
    });
    client?.diagnostics?.set(document.uri, [item]);
    status.text = "Tinta: source limit exceeded";
    return false;
  };
  const updateVisibility = () => {
    status.text = "Tinta: source only";
    if (vscode.window.activeTextEditor?.document.languageId === "tinta")
      status.show();
    else status.hide();
  };
  context.subscriptions.push(
    status,
    vscode.window.onDidChangeActiveTextEditor(updateVisibility),
  );
  updateVisibility();
  const output = privateOutput();
  context.subscriptions.push(output);
  client = new LanguageClient(
    "tinta",
    "Tinta",
    {
      module: context.asAbsolutePath("dist/server.mjs"),
      transport: TransportKind.ipc,
      options: { execArgv: [] },
    },
    {
      documentSelector: [
        { language: "tinta", scheme: "file" },
        { language: "tinta", scheme: "untitled" },
      ],
      outputChannel: output,
      traceOutputChannel: output,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      middleware: {
        didOpen: async (document, next) => {
          if (bounded(document)) await next(document);
        },
        didChange: async (event, next) => {
          status.text = "Tinta: checking";
          if (bounded(event.document)) await next(event);
        },
      },
    },
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tinta.check", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (
        document?.languageId !== "tinta" ||
        !["file", "untitled"].includes(document.uri.scheme)
      )
        return;
      if (!bounded(document)) return;
      await client?.sendRequest("tinta/check", {
        uri: document.uri.toString(),
        version: document.version,
        text: document.getText(),
      });
    }),
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      const openUris = new Set(
        vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.flatMap((tab) =>
            tab.input instanceof vscode.TabInputText
              ? [tab.input.uri.toString()]
              : [],
          ),
        ),
      );
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        if (openUris.has(uri.toString())) continue;
        files?.release(uri.toString());
        previews?.release(uri.toString());
        client?.diagnostics?.delete(uri);
        void client?.sendNotification("tinta/close", { uri: uri.toString() });
      }
      for (const tab of event.opened) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri.toString();
        const document = vscode.workspace.textDocuments.find(
          (item) => item.uri.toString() === uri,
        );
        if (
          document?.languageId === "tinta" &&
          ["file", "untitled"].includes(document.uri.scheme)
        ) {
          if (!bounded(document)) continue;
          void client?.sendRequest("tinta/check", {
            uri,
            version: document.version,
            text: document.getText(),
          });
        }
      }
    }),
  );
  try {
    await client.start();
    previews = new PreviewController((method, params) =>
      client!.sendRequest(method, params),
    );
    files = new FileController(previews);
    context.subscriptions.push(files, previews);
    context.subscriptions.push(
      client.onNotification(
        "tinta/status",
        (value: { uri: string; version?: number; source: string }) => {
          const document = vscode.window.activeTextEditor?.document;
          if (
            document?.uri.toString() !== value.uri ||
            (value.version !== undefined && document.version !== value.version)
          )
            return;
          status.text =
            value.source === "capacity"
              ? "Tinta: host capacity; retry Check"
              : value.source === "valid"
                ? "Tinta: source valid"
                : "Tinta: source errors";
        },
      ),
    );
  } catch {
    void vscode.window.showErrorMessage(
      `Tinta could not start. Incident: ${randomBytes(16).toString("hex")}.`,
    );
  }
}

export async function deactivate(): Promise<void> {
  files?.dispose();
  files = undefined;
  previews?.dispose();
  previews = undefined;
  await client?.stop();
  client = undefined;
}
