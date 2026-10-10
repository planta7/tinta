import { sourceIdentity } from "@tinta/types/webview";
import { limits } from "@tinta/types/common";
import type { SourceIdentity } from "@tinta/types/editor";
import type { AuthoringQuery } from "./authoring.js";
import type {
  CompletionItem,
  DocumentSymbol,
  Hover,
  Location,
  SignatureHelp,
  CancellationToken,
} from "vscode-languageserver/node";
import { Worker } from "node:worker_threads";
import {
  createConnection,
  IPCMessageReader,
  IPCMessageWriter,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { Supervisor } from "./supervisor.js";
import {
  diagnosticPresentation,
  semanticTokens,
  tokenTypes,
  foldingRanges,
} from "./presentation.js";
import type { AnalysisWorker } from "./protocol.js";

// Explicit IPC avoids SDK command-line transport selection and listening sockets.
const connection = createConnection(
  new IPCMessageReader(process),
  new IPCMessageWriter(process),
);
const supervisor = new Supervisor({
  debounceMs: 200,
  watchdogMs: 3000,
  createWorker: () =>
    new Worker(new URL("./worker.mjs", import.meta.url)) as AnalysisWorker,
  publish: (request, result) => {
    void connection.sendDiagnostics({
      uri: request.uri,
      version: request.version,
      diagnostics: diagnosticPresentation(request.text, result.diagnostics),
    });
    void connection.sendNotification("tinta/status", {
      uri: request.uri,
      version: request.version,
      source: result.snapshot?.validity ?? "invalid",
      fidelity: "unverified",
      assets: "not-checked",
    });
    void connection.languages.semanticTokens.refresh();
  },
  capacity: (uri) => {
    void connection.sendDiagnostics({ uri, diagnostics: [] });
    void connection.sendNotification("tinta/status", {
      uri,
      source: "capacity",
      fidelity: "unverified",
      assets: "not-checked",
    });
  },
});

connection.onInitialize((params) => {
  const encodings = params.capabilities.general?.positionEncodings;
  if (encodings && !encodings.includes("utf-16"))
    throw new Error("UTF-16 positions are required.");
  return {
    capabilities: {
      positionEncoding: "utf-16",
      textDocumentSync: TextDocumentSyncKind.Full,
      foldingRangeProvider: true,
      completionProvider: { triggerCharacters: ["@", ".", ":"] },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [")"],
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes, tokenModifiers: [] },
        full: true,
      },
    },
  };
});
connection.onDidOpenTextDocument(({ textDocument }) => {
  if (textDocument.languageId === "tinta")
    supervisor.update(
      textDocument.uri,
      textDocument.version,
      textDocument.text,
    );
});
connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  const change = contentChanges[0];
  if (contentChanges.length === 1 && change && !("range" in change)) {
    supervisor.update(textDocument.uri, textDocument.version, change.text);
  }
});
connection.onDidCloseTextDocument(({ textDocument }) => {
  supervisor.close(textDocument.uri);
  void connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
});
connection.onNotification("tinta/close", ({ uri }: { uri: string }) => {
  supervisor.close(uri);
  void connection.sendDiagnostics({ uri, diagnostics: [] });
});
connection.onNotification(
  "tinta/source-limit",
  ({ uri, version }: { uri: string; version: number }) => {
    supervisor.close(uri);
    void connection.sendDiagnostics({
      uri,
      version,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: 1,
          code: "E_LIMIT",
          source: "tinta",
          message: "Source byte limit exceeded.",
        },
      ],
    });
  },
);
connection.onRequest(
  "tinta/check",
  (params: { uri: string; version: number; text: string }) => {
    supervisor.update(params.uri, params.version, params.text);
    supervisor.check(params.uri);
  },
);
connection.languages.semanticTokens.on(({ textDocument }) => {
  const snapshot = supervisor.snapshot(textDocument.uri);
  return { data: snapshot ? semanticTokens(snapshot) : [] };
});
connection.onFoldingRanges(({ textDocument }) => {
  const snapshot = supervisor.snapshot(textDocument.uri);
  return snapshot ? foldingRanges(snapshot) : [];
});
async function query<T>(
  uri: string,
  params: AuthoringQuery,
  token: CancellationToken,
): Promise<T | null> {
  if (token.isCancellationRequested) return null;
  const result = await supervisor.query(uri, params);
  return token.isCancellationRequested ? null : (result as T | null);
}

connection.onCompletion((params, token) =>
  query<CompletionItem[]>(
    params.textDocument.uri,
    { kind: "completion", position: params.position },
    token,
  ),
);
connection.onHover((params, token) =>
  query<Hover>(
    params.textDocument.uri,
    { kind: "hover", position: params.position },
    token,
  ),
);
connection.onSignatureHelp((params, token) =>
  query<SignatureHelp>(
    params.textDocument.uri,
    { kind: "signature", position: params.position },
    token,
  ),
);
connection.onDefinition((params, token) =>
  query<Location[]>(
    params.textDocument.uri,
    { kind: "definition", position: params.position },
    token,
  ),
);
connection.onReferences((params, token) =>
  query<Location[]>(
    params.textDocument.uri,
    {
      kind: "references",
      position: params.position,
      includeDeclaration: params.context.includeDeclaration,
    },
    token,
  ),
);
connection.onDocumentSymbol((params, token) =>
  query<DocumentSymbol[]>(params.textDocument.uri, { kind: "symbols" }, token),
);
connection.onRequest(
  "tinta/preview",
  async (params: { identity: SourceIdentity; text: string }) => {
    if (
      !sourceIdentity(params?.identity) ||
      typeof params.text !== "string" ||
      Buffer.byteLength(params.text, "utf8") > limits.sourceBytes
    )
      return null;
    return supervisor.query(params.identity.uri, {
      kind: "preview",
      preview: params,
    });
  },
);
connection.onShutdown(() => supervisor.dispose());
connection.onExit(() => supervisor.dispose());
connection.listen();
