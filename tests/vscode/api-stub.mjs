import { vi } from "vitest";
export const env = { uiKind: 1, remoteName: undefined };
export const ViewColumn = { Beside: -2 };
export const UIKind = { Desktop: 1 };
export const StatusBarAlignment = { Right: 2 };
export const DiagnosticSeverity = { Error: 0 };
export class Range {
  constructor(...values) {
    this.values = values;
  }
}
export class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
export class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}
export const handlers = {};
const subscriptions = new Map();
const subscribe = (name) => (handler) => {
  if (!["open", "change", "save", "close"].includes(name)) {
    handlers[name] = handler;
    return { dispose: vi.fn() };
  }
  if (!subscriptions.has(name)) subscriptions.set(name, new Set());
  const listeners = subscriptions.get(name);
  listeners.add(handler);
  handlers[name] = (...args) => {
    for (const listener of listeners) listener(...args);
  };
  return { dispose: () => listeners.delete(handler) };
};
export const output = {
  name: "Tinta",
  error: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};
export const status = {
  text: "",
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};
export const workspace = {
  workspaceFolders: [],
  isTrusted: true,
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  textDocuments: [],
  onDidOpenTextDocument: subscribe("open"),
  onDidChangeTextDocument: subscribe("change"),
  onDidSaveTextDocument: subscribe("save"),
  onDidCloseTextDocument: subscribe("close"),
};
export const window = {
  activeTextEditor: undefined,
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  createStatusBarItem: () => status,
  createOutputChannel: () => output,
  onDidChangeActiveTextEditor: subscribe("active"),
  tabGroups: { all: [], onDidChangeTabs: subscribe("tabs") },
};
export const commands = {
  registerCommand: (_name, callback) => {
    handlers[_name === "tinta.check" ? "check" : _name] = callback;
    return { dispose: vi.fn() };
  },
};

export const ProgressLocation = { Notification: 15 };
export const Uri = {
  parse: (value) => ({
    scheme: value.slice(0, value.indexOf(":")),
    toString: () => value,
  }),
};
