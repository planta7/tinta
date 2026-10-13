import { testAuthoring } from "./authoring.mjs";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Supervisor } from "../../packages/language-server/dist/supervisor.js";

const root = process.env.TINTA_EDITING_TEST_ROOT;
const results = [];

async function until(predicate, message, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function open(name, text) {
  const path = join(root, name);
  await writeFile(path, text);
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document);
  return document;
}

async function check(document, code) {
  await vscode.commands.executeCommand("tinta.check");
  await until(
    () =>
      vscode.languages
        .getDiagnostics(document.uri)
        .some((item) => item.code === code),
    `Missing ${code}`,
  );
}

export async function run() {
  try {
    const document = await open("editing.tinta", "😀 {{ missing }}\n");
    assert.equal(document.languageId, "tinta");
    await vscode.extensions.getExtension("tinta-local.tinta")?.activate();
    // Workspace package names are internal; activation is also automatic by language.
    await until(
      async () => (await vscode.commands.getCommands()).includes("tinta.check"),
      "Extension did not activate",
    );
    await check(document, "E_NAME_UNKNOWN");
    const error = vscode.languages
      .getDiagnostics(document.uri)
      .find((item) => item.code === "E_NAME_UNKNOWN");
    assert.equal(error.range.start.character, 6);
    assert.equal(error.range.end.character, 13);
    results.push("UTF-16 astral diagnostic range");
    await testAuthoring(open, results);
    await vscode.window.showTextDocument(document);

    const editor = vscode.window.activeTextEditor;
    await editor.edit((edit) =>
      edit.replace(new vscode.Range(0, 6, 0, 13), "12"),
    );
    await until(
      () => vscode.languages.getDiagnostics(document.uri).length === 0,
      "Valid edit retained diagnostics",
    );
    await vscode.commands.executeCommand(
      "workbench.action.focusActiveEditorGroup",
    );
    await vscode.commands.executeCommand("undo");
    await until(
      () => document.getText() === "😀 {{ missing }}\n",
      "Undo did not restore the original source",
    );
    await check(document, "E_NAME_UNKNOWN");
    await vscode.commands.executeCommand("redo");
    await until(
      () => vscode.languages.getDiagnostics(document.uri).length === 0,
      "Redo retained diagnostics",
    );
    results.push("typing, undo and redo");

    const second = await open("other.tinta", "@let n = 1\n@let n = 2\n");
    await check(second, "E_NAME_DUPLICATE");
    assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
    assert.ok(
      vscode.languages
        .getDiagnostics(second.uri)
        .find((item) => item.code === "E_NAME_DUPLICATE").relatedInformation
        .length,
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await until(
      () => vscode.languages.getDiagnostics(second.uri).length === 0,
      "Close retained diagnostics",
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(second.uri),
    );
    await check(second, "E_NAME_DUPLICATE");
    results.push("multiple documents, related locations, close/reopen");

    const literal = await open(
      "literal.tinta",
      "```tinta\n@let inactive = unknown\n```\n<!-- {{ hidden }} -->\n@let active = 1\n{{ active }}\n",
    );
    await vscode.commands.executeCommand("tinta.check");
    let tokens;
    await until(async () => {
      tokens = await vscode.commands.executeCommand(
        "vscode.provideDocumentSemanticTokens",
        literal.uri,
      );
      return tokens?.data?.length > 0;
    }, "No semantic tokens");
    let line = 0;
    for (let index = 0; index < tokens.data.length; index += 5) {
      line += tokens.data[index];
      assert.ok(line >= 4, "Literal region received semantic tokens");
    }
    const folding = await open("folding.tinta", "@when true\nText\n@end\n");
    await vscode.commands.executeCommand("tinta.check");
    await until(async () => {
      const ranges = await vscode.commands.executeCommand(
        "vscode.executeFoldingRangeProvider",
        folding.uri,
      );
      return ranges?.some((range) => range.start === 0 && range.end === 2);
    }, "Missing parser block folding");
    const untitled = await vscode.workspace.openTextDocument({
      language: "tinta",
      content: "{{ missing }}\n",
    });
    await vscode.window.showTextDocument(untitled);
    await check(untitled, "E_NAME_UNKNOWN");
    const tabs = await open("tabs.tinta", "\tcode\n\nText\n");
    assert.equal(tabs.getText(), "\tcode\n\nText\n");
    results.push(
      "parser folding, explicit untitled language and retained tabs",
    );
    const oversized = await open("oversized.tinta", "x".repeat(2097153));
    await check(oversized, "E_LIMIT");
    await vscode.window.activeTextEditor.edit((edit) =>
      edit.replace(new vscode.Range(0, 0, 0, 2097153), "{{ missing }}"),
    );
    await check(oversized, "E_NAME_UNKNOWN");
    results.push(
      "bounded synchronization and oversized-to-valid-size recovery",
    );
    const markdown = await open(
      "plain.md",
      "@let x = missing\n{{ unknown }}\n",
    );
    assert.equal(markdown.languageId, "markdown");
    assert.deepEqual(vscode.languages.getDiagnostics(markdown.uri), []);
    results.push("semantic literal boundaries and Markdown profile");

    const indentation = await open("indent.tinta", "@when true\n");
    const indentEditor = vscode.window.activeTextEditor;
    indentEditor.selection = new vscode.Selection(0, 10, 0, 10);
    await vscode.commands.executeCommand("type", { text: "\n" });
    assert.equal(indentation.getText(), "@when true\n\n");
    results.push("physical column-one block editing");

    const replies = [];
    let created = 0;
    let lastWorker;
    const supervisor = new Supervisor({
      debounceMs: 200,
      watchdogMs: 3000,
      createWorker: () => {
        lastWorker = new Worker(
          join(root, created++ === 0 ? "stall.mjs" : "worker.mjs"),
        );
        return lastWorker;
      },
      publish: (request, result) => replies.push({ request, result }),
      capacity: () => assert.fail("Unexpected capacity"),
    });
    try {
      supervisor.update("untitled:stalled", 1, "@let n = 1\n");
      const started = Date.now();
      supervisor.check("untitled:stalled");
      const heartbeat = [];
      let last = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        heartbeat.push(now - last);
        last = now;
      }, 10);
      await indentEditor.edit((edit) =>
        edit.insert(new vscode.Position(0, 0), "Text\n"),
      );
      await until(() => replies.length === 1, "Worker timeout missing", 5000);
      clearInterval(timer);
      assert.equal(replies[0].result.diagnostics[0].code, "E_WORKER_TIMEOUT");
      assert.ok(Date.now() - started < 4000);
      assert.ok(
        Math.max(...heartbeat) < 100,
        `Host blocked: ${Math.max(...heartbeat)} ms`,
      );
      supervisor.update("untitled:stalled", 2, "@let n = 2\n");
      supervisor.check("untitled:stalled");
      await until(() => replies.length === 2, "Worker did not restart");
      assert.equal(replies[1].result.snapshot.validity, "valid");
      assert.equal(created, 2);
      const retired = lastWorker;
      const old = replies[1];
      supervisor.update("untitled:stalled", 3, "@let n = 3\n");
      supervisor.check("untitled:stalled");
      supervisor.update("untitled:stalled", 4, "@let n = 4\n");
      retired.emit("message", {
        request: old.request,
        result: { ok: true, value: old.result.snapshot, diagnostics: [] },
      });
      assert.equal(replies.length, 2);
      supervisor.check("untitled:stalled");
      await until(
        () => replies.length === 3,
        "Superseded work did not recover",
      );
      assert.equal(replies[2].request.version, 4);
      results.push("late reply from retired native worker rejected");
      results.push({
        name: "native worker timeout, concurrent edit and restart",
        maximumEventLoopDelayMs: Math.max(...heartbeat),
        samples: heartbeat.length,
      });
    } finally {
      supervisor.dispose();
    }
    const previewDocument = await vscode.workspace.openTextDocument({
      language: "tinta",
      content:
        '@slider amount = 2 (min: 0, max: 5, label: "Amount")\nValue: {{ amount }}',
    });
    await vscode.window.showTextDocument(previewDocument);
    await vscode.commands.executeCommand("tinta.openPreview");
    await until(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some(
            (tab) =>
              tab.input instanceof vscode.TabInputWebview &&
              tab.label === "tinta Preview",
          ),
        ),
      "Native preview did not complete the LSP compilation path",
    );
    results.push(
      "native preview command, supervised compilation and webview load",
    );
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          status: "PASS",
          vscode: vscode.version,
          node: process.versions.node,
          results,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        { status: "FAIL", results, error: String(error), stack: error.stack },
        null,
        2,
      ),
    );
    throw error;
  }
}
