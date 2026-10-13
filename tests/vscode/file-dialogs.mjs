import * as native from "vscode";
export * from "vscode";
export const choices = {
  open: undefined,
  save: undefined,
  answers: "Document starting values",
  confirm: true,
  messages: [],
  cancel: undefined,
};
const overrides = {
  get activeTextEditor() {
    return native.window.activeTextEditor;
  },
  showOpenDialog: async () => choices.open,
  showSaveDialog: async () => choices.save,
  showQuickPick: async () => choices.answers,
  showWarningMessage: async (message, _options, choice) => {
    choices.messages.push(message);
    return choices.confirm ? choice : undefined;
  },
  showInformationMessage: async (message, choice) => {
    choices.messages.push(message);
    return choices.confirm ? choice : undefined;
  },
  showErrorMessage: async (message) => {
    choices.messages.push(message);
  },
  withProgress: async (_options, action) =>
    action(
      {},
      {
        onCancellationRequested(callback) {
          choices.cancel = callback;
          return {
            dispose() {
              choices.cancel = undefined;
            },
          };
        },
      },
    ),
};

export const window = new Proxy(
  {},
  {
    get(_target, key) {
      return key in overrides ? overrides[key] : native.window[key];
    },
  },
);
