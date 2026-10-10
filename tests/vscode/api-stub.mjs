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
const subscribe = (name) => (handler) => {
  handlers[name] = handler;
  return { dispose: vi.fn() };
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
