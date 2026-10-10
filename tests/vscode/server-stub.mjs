import { vi } from "vitest";
export const handlers = {};
export const connection = {
  sendDiagnostics: vi.fn(),
  sendNotification: vi.fn(),
  listen: vi.fn(),
  languages: {
    semanticTokens: {
      refresh: vi.fn(),
      on: (fn) => {
        handlers.tokens = fn;
      },
    },
  },
  onInitialize: (fn) => {
    handlers.initialize = fn;
  },
  onDidOpenTextDocument: (fn) => {
    handlers.open = fn;
  },
  onDidChangeTextDocument: (fn) => {
    handlers.change = fn;
  },
  onDidCloseTextDocument: (fn) => {
    handlers.close = fn;
  },
  onNotification: (name, fn) => {
    handlers[name] = fn;
  },
  onRequest: (name, fn) => {
    handlers[name] = fn;
  },
  onFoldingRanges: (fn) => {
    handlers.folding = fn;
  },
  onCompletion: (fn) => {
    handlers.completion = fn;
  },
  onHover: (fn) => {
    handlers.hover = fn;
  },
  onSignatureHelp: (fn) => {
    handlers.signature = fn;
  },
  onDefinition: (fn) => {
    handlers.definition = fn;
  },
  onReferences: (fn) => {
    handlers.references = fn;
  },
  onDocumentSymbol: (fn) => {
    handlers.symbols = fn;
  },
  onShutdown: (fn) => {
    handlers.shutdown = fn;
  },
  onExit: (fn) => {
    handlers.exit = fn;
  },
};
export class IPCMessageReader {
  constructor(process) {
    this.process = process;
  }
}
export class IPCMessageWriter {
  constructor(process) {
    this.process = process;
  }
}
export const TextDocumentSyncKind = { Full: 1 };
export function createConnection(reader, writer) {
  Object.assign(connection, { reader, writer });
  return connection;
}
