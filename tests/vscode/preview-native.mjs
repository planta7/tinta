import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PreviewController } from "../../apps/vscode/dist/preview.js";
import { preparePreview } from "../../packages/language-service/dist/index.js";

const waitFor = async (predicate, label, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
};

export async function run() {
  const root = process.env.TINTA_PREVIEW_TEST_ROOT;
  const report = { status: "FAIL", vscode: vscode.version, groups: [] };
  const controller = new PreviewController(async (method, params) =>
    method === "tinta/preview"
      ? JSON.parse(JSON.stringify(preparePreview(params.identity, params.text)))
      : null,
  );
  const responses = new Map();
  report.messages = [];
  const receive = controller.receive.bind(controller);
  controller.receive = (state, message) => {
    if (message?.kind === "preview-test-result")
      responses.set(message.id, message);
    else {
      report.messages.push({
        kind: message?.kind,
        requestId: message?.requestId,
        current: state.identity.requestId,
        identityMatch: message?.panelId === state.identity.panelId,
        source: message?.source?.sourceRevision,
        title: state.panel.title,
      });
      receive(state, message);
    }
  };
  let next = 0;
  const audit = async (state, action, value) => {
    const id = ++next;
    await state.panel.webview.postMessage({
      kind: "preview-test",
      id,
      action,
      value,
    });
    const result = await waitFor(() => responses.get(id), action);
    assert.equal(result.error, undefined);
    return result;
  };
  const inspect = async (state, predicate) =>
    waitFor(async () => {
      const result = await audit(state, "inspect");
      return predicate(result) && result;
    }, "reader projection");
  try {
    const atlas = await readFile(join(root, "atlas.tinta"), "utf8");
    const prefix =
      '@slider amount = 5 (min: 0, max: 10, step: 1, label: "Amount")\n@calc ratio = 1 / amount\nRatio: {{ ratio }}\n\n';
    // Metadata stays at the document start; append the additional controls.
    const source =
      atlas +
      "\n" +
      prefix +
      '\n@details "More"\nMore text.\n@end\n\n[External](https://example.invalid/)\n\n<script>throw new Error("AUTHOR SCRIPT")</script>\n';
    const path = join(root, "document 😀.tinta");
    await writeFile(path, source);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path),
    );
    const editor = await vscode.window.showTextDocument(document);
    await waitFor(
      () => controller.sources.get(document)?.snapshot,
      "source verification",
    );
    await vscode.commands.executeCommand("tinta.openPreview");
    const state = controller.panels.get(document);
    assert.ok(state);
    await waitFor(() => state.sessionRevision >= 0, "preview state");
    const initial = await inspect(state, (value) => value.charts >= 7);
    assert.equal(initial.charts, 7);
    assert.equal(initial.focused, true);
    assert.ok(initial.controls.every((control) => control.label));
    report.groups.push("all seven chart types, labels, focus and host colors");
    report.colors = { background: initial.background, text: initial.color };
    const luminance = (color) => {
      const values = color
        .match(/\d+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const component = value / 255;
          return component <= 0.04045
            ? component / 12.92
            : ((component + 0.055) / 1.055) ** 2.4;
        });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    report.contrast =
      (luminance(initial.background) + 0.05) /
      (luminance(initial.color) + 0.05);
    assert.ok(report.contrast >= 4.5);
    if (process.env.TINTA_PREVIEW_KEYBOARD === "true") {
      await writeFile(
        join(root, "keyboard-ready.json"),
        JSON.stringify({ ready: true }),
      );
      await waitFor(
        async () => {
          try {
            return await readFile(join(root, "keyboard-continue.json"), "utf8");
          } catch {
            return false;
          }
        },
        "native keyboard observation",
        300000,
      );
      const keyboard = await audit(state, "inspect");
      report.keyboard = keyboard;
      assert.equal(keyboard.controls.at(-1).value, "6");
      assert.ok(keyboard.text.includes("Ratio: 0.1666666667"));
      report.groups.push(
        "native keyboard ArrowRight changed the focused slider",
      );
      await audit(state, "control", 5);
    }

    const security = await audit(state, "security");
    for (const key of [
      "storage",
      "parent",
      "vscodeAbsent",
      "network",
      "file",
      "linkActivated",
    ])
      assert.equal(security[key], true, key);
    assert.equal(security.linkTarget, "_blank");
    assert.match(security.linkRel, /noopener/);
    assert.equal(initial.externalImages, 0);
    assert.equal(initial.scripts, 2);
    report.groups.push(
      "opaque origin, denied storage/network/files and explicit external-link dispatch",
    );

    await audit(state, "control", 4);
    await inspect(state, (value) => value.text.includes("Ratio: 0.25"));
    await audit(state, "control", 0);
    await inspect(state, (value) => value.text.includes("Ratio: 0.25"));
    await audit(state, "details");
    await vscode.window.showTextDocument(document, editor.viewColumn);
    await editor.edit((edit) =>
      edit.insert(
        document.positionAt(document.getText().length),
        "\n@calc invalid = missing\n",
      ),
    );
    await waitFor(
      () => state.panel.title.includes("Source errors"),
      "invalid source",
    );
    const stale = await inspect(state, (value) => value.inert);
    assert.ok(stale.controls.every((control) => control.disabled));
    assert.ok(stale.text.includes("Ratio: 0.25"));
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(0, 0, document.lineCount, 0),
        source + "\nChanged prose.\n",
      ),
    );
    await waitFor(
      () => state.panel.title === "tinta Preview",
      "recovered source",
    );
    const recovered = await inspect(
      state,
      (value) => !value.inert && value.text.includes("Changed prose."),
    );
    assert.ok(recovered.text.includes("Ratio: 0.25"));
    assert.equal(recovered.details, false);
    report.groups.push(
      "rejected reader update rollback, stale disabling, valid recovery and presentation reset",
    );

    const changedInitial = source.replace(
      "@slider amount = 5",
      "@slider amount = 2",
    );
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(0, 0, document.lineCount, 0),
        changedInitial,
      ),
    );
    await inspect(state, (value) => value.text.includes("Ratio: 0.5"));
    report.groups.push(
      "authored initial belongs to the reconciliation signature",
    );
    const previousIdentity = { ...state.identity };
    controller.reconstruct(state);
    await waitFor(() => state.sessionRevision >= 0, "reconstructed preview");
    await inspect(state, (value) => value.text.includes("Ratio: 0.5"));
    assert.notEqual(state.identity.capability, previousIdentity.capability);
    report.groups.push(
      "webview reconstruction resets answers with a fresh capability",
    );

    const retainedSource = controller.sources.get(document).snapshot;
    const retainedText = document.getText();
    assert.equal(document.isDirty, true);
    await vscode.commands.executeCommand("tinta.showPreview");
    await waitFor(
      () => state.panel.active && state.panel.viewColumn === editor.viewColumn,
      "preview in the source group",
    );
    const webviewResource = vscode.Uri.from({
      scheme: "webview-panel",
      path: "webview-panel/opaque-native-resource",
    });
    assert.ok(
      !vscode.window.visibleTextEditors.some(
        (visible) => visible.document === document,
      ),
    );
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === document.uri.toString(),
        ),
      ),
    );
    await vscode.commands.executeCommand("tinta.openPreview", webviewResource);
    await waitFor(
      () =>
        state.panel.visible &&
        vscode.window.visibleTextEditors.some(
          (visible) =>
            visible.document === document &&
            visible.viewColumn !== state.panel.viewColumn,
        ),
      "source and preview in adjacent groups",
    );
    await state.panel.reveal(state.panel.viewColumn, false);
    await waitFor(() => state.panel.active, "focused preview toolbar");
    await vscode.commands.executeCommand("tinta.showSource", webviewResource);
    await waitFor(
      () =>
        !state.panel.visible &&
        vscode.window.activeTextEditor?.document === document,
      "source view hides preview",
    );
    assert.equal(document.getText(), retainedText);
    assert.equal(document.isDirty, true);
    assert.equal(controller.sources.get(document).snapshot, retainedSource);
    assert.equal(controller.panels.get(document), state);
    const hiddenCapability = state.identity.capability;
    await vscode.commands.executeCommand("tinta.showPreview", document.uri);
    await waitFor(
      () =>
        state.identity.capability !== hiddenCapability &&
        state.panel.active &&
        state.enabled,
      "recreated preview after returning from source",
    );
    await inspect(state, (value) => value.text.includes("Ratio: 0.5"));
    report.groups.push(
      "source, split and preview views retain the dirty source and document instance",
    );

    const other = await vscode.workspace.openTextDocument({
      language: "tinta",
      content: "# Independent",
    });
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand("tinta.openPreview");
    const second = controller.panels.get(other);
    await waitFor(() => second?.sessionRevision >= 0, "second preview");
    await inspect(second, (value) => value.text.includes("Independent"));
    assert.notEqual(
      second.identity.source.documentInstance,
      state.identity.source.documentInstance,
    );
    controller.receive(second, {
      ...second.identity,
      source: state.identity.source,
      kind: "state",
      controls: {},
      sessionRevision: 999,
      assetRevision: 0,
    });
    await waitFor(
      () => !controller.panels.has(other),
      "foreign document rejected",
    );
    report.groups.push(
      "independent documents and rejected cross-document state",
    );
    for (let index = 0; index < 3; index++) {
      state.panel.dispose();
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("tinta.openPreview");
      const nextState = controller.panels.get(document);
      await waitFor(() => nextState?.sessionRevision >= 0, "repeated mount");
      nextState.panel.dispose();
    }
    assert.equal(controller.panels.size, 0);
    report.groups.push("repeated panel and port disposal");
    report.status = "PASS";
  } catch (error) {
    report.panels = [...controller.panels.values()].map((state) => ({
      ready: state.ready,
      title: state.panel.title,
      revision: state.sessionRevision,
      request: state.identity.requestId,
    }));
    report.error = String(error.stack ?? error);
    throw error;
  } finally {
    controller.dispose();
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  }
}
