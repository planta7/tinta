import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { FileController } from "../../apps/vscode/dist/files.js";
import { PreviewController } from "../../apps/vscode/dist/preview.js";
import { runArtifact } from "../../apps/vscode/dist/artifacts.js";
import { preparePreview } from "../../packages/language-service/dist/index.js";
import { openBundle } from "../../packages/artifacts/dist/index.js";
import { choices } from "./file-dialogs.mjs";

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
};
export async function run() {
  const root = process.env.TINTA_FILES_TEST_ROOT;
  const report = {
    status: "FAIL",
    vscode: vscode.version,
    node: process.version,
    trusted: vscode.workspace.isTrusted,
    groups: [],
    dialogs:
      "Scripted selections; native document, diff, command, worker and webview APIs",
  };
  const previews = new PreviewController(async (method, params) =>
    method === "tinta/preview"
      ? JSON.parse(JSON.stringify(preparePreview(params.identity, params.text)))
      : null,
  );
  let duringProduce;
  const files = new FileController(previews, async (request, signal) => {
    const result = await runArtifact(request, signal);
    if (request.kind === "produce") await duringProduce?.();
    return result;
  });
  const command = (name) => vscode.commands.executeCommand(`tinta.${name}`);
  try {
    const source =
      '@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")\nValue: {{ amount }}\n\n![Pixel](photo%20%C3%B1.png)\n\n@when false\nSecret ![Hidden](missing.png)\n@end\n';
    const path = join(root, "source 😀.tinta");
    await writeFile(path, source);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    const editor = await vscode.window.showTextDocument(doc);
    await waitFor(
      () => previews.sources.get(doc)?.snapshot,
      "verified native source",
    );
    choices.save = vscode.Uri.file(join(root, "static.html"));
    if (!vscode.workspace.isTrusted) {
      for (const name of [
        "selectImageRoot",
        "refreshImages",
        "enrichMarkdown",
        "openSourceBundle",
        "saveSourceBundle",
        "exportInteractive",
        "exportStatic",
      ])
        await command(name);
      assert.equal(
        choices.messages.filter((message) =>
          message.includes("trusted local workspace"),
        ).length,
        7,
      );
      assert.equal((await readdir(root)).includes("static.html"), false);
      report.groups.push(
        "actual Restricted Mode denies every IO handler; exact source verification remains available",
      );
    } else {
      assert.equal(
        await editor.edit((edit) =>
          edit.insert(new vscode.Position(1, 0), "Unsaved 😀 "),
        ),
        true,
      );
      assert.equal(doc.isDirty, true);
      await command("exportStatic");
      assert.match(choices.messages.at(-1), /E_ASSET_MISSING/);
      choices.open = [vscode.Uri.file(root)];
      await command("selectImageRoot");
      assert.match(choices.messages.at(-1), /E_ASSET_MISSING/);
      assert.equal(files.resources.get(doc)?.assets.size, 1);
      await command("exportStatic");
      const visibleOnly = await readFile(choices.save.fsPath, "utf8");
      assert.ok(visibleOnly.includes("image/png"));
      assert.ok(!visibleOnly.includes("Secret"));
      report.groups.push(
        "visible image export succeeds while hidden image is missing",
      );
      // Interactive output still needs every source image.
      await writeFile(
        join(root, "missing.png"),
        await readFile(join(root, "photo ñ.png")),
      );
      await command("refreshImages");
      assert.equal(files.resources.get(doc)?.assets.size, 2);
      await command("openPreview");
      const panel = previews.panels.get(doc);
      await waitFor(() => panel?.enabled, "native preview with image bytes");
      const reading = await previews.reading(doc, await previews.source(doc));
      assert.deepEqual(reading.controls, { amount: 2 });
      assert.equal(reading.current(), true);
      report.groups.push(
        "dirty Unicode source and explicit image root in actual webview",
      );
      await command("exportStatic");
      const staticHtml = await readFile(choices.save.fsPath, "utf8");
      assert.ok(staticHtml.includes("Unsaved 😀"));
      assert.ok(staticHtml.includes("image/png"));
      assert.ok(!staticHtml.includes("tinta-ir-1"));
      assert.equal(await readFile(path, "utf8"), source);
      choices.answers = "Current preview answers";
      choices.save = vscode.Uri.file(join(root, "interactive.html"));
      await command("exportInteractive");
      assert.ok(
        (await readFile(choices.save.fsPath, "utf8")).includes(
          "tinta-interactive",
        ),
      );
      await command("resetReading");
      await waitFor(() => panel.enabled, "reading reset");
      report.groups.push(
        "initial/static and current/interactive unsaved exports, reset and source preservation",
      );
      choices.save = vscode.Uri.file(join(root, "bundle.tinta.zip"));
      await command("saveSourceBundle");
      const bundle = await openBundle(await readFile(choices.save.fsPath));
      assert.equal(bundle.ok, true);
      choices.open = [choices.save];
      await command("openSourceBundle");
      const opened = vscode.window.activeTextEditor.document;
      assert.notEqual(opened, doc);
      assert.equal(opened.uri.scheme, "untitled");
      assert.equal(opened.languageId, "tinta");
      assert.ok(opened.uri.path.endsWith(".tinta"));
      assert.equal(files.resources.get(opened).assets.size, 1);
      assert.equal((await readdir(root)).includes("assets"), false);
      report.groups.push(
        "validated bundle opens a distinct native buffer and retains images without extraction",
      );
      const markdownPath = join(root, "notes ñ.md");
      await writeFile(markdownPath, "Literal {{ amount }}\n");
      const markdown = await vscode.workspace.openTextDocument(
        vscode.Uri.file(markdownPath),
      );
      await vscode.window.showTextDocument(markdown);
      await command("enrichMarkdown");
      assert.equal(markdown.languageId, "markdown");
      assert.notEqual(vscode.window.activeTextEditor.document, markdown);
      assert.equal(vscode.window.activeTextEditor.document.languageId, "tinta");
      assert.equal(
        await readFile(markdownPath, "utf8"),
        "Literal {{ amount }}\n",
      );
      report.groups.push(
        "native enrichment diff and separate Tinta copy preserve Markdown",
      );
      await vscode.window.showTextDocument(doc);
      choices.answers = "Document starting values";
      choices.save = vscode.Uri.file(join(root, "cancelled.html"));
      duringProduce = async () => {
        await editor.edit((edit) =>
          edit.insert(new vscode.Position(0, 0), "Changed\n"),
        );
      };
      await command("exportStatic");
      assert.equal((await readdir(root)).includes("cancelled.html"), false);
      duringProduce = () => choices.cancel();
      await command("exportStatic");
      assert.equal((await readdir(root)).includes("cancelled.html"), false);
      duringProduce = undefined;
      choices.save = vscode.Uri.file(path);
      await command("exportStatic");
      assert.match(choices.messages.at(-1), /replace an input/);
      const alias = join(root, "alias.html");
      await symlink(path, alias);
      choices.save = vscode.Uri.file(alias);
      await command("exportStatic");
      assert.match(choices.messages.at(-1), /replace an input/);
      const readonly = join(root, "readonly.html");
      await writeFile(readonly, "KEEP");
      await chmod(readonly, 0o444);
      choices.save = vscode.Uri.file(readonly);
      await command("exportStatic");
      assert.match(choices.messages.at(-1), /read-only/);
      assert.equal(await readFile(readonly, "utf8"), "KEEP");
      await chmod(readonly, 0o644);
      assert.equal(
        (await readdir(root)).some((name) => name.endsWith(".tmp")),
        false,
      );
      report.groups.push(
        "edits during generation, cancellation, aliases and read-only targets preserve prior files",
      );
    }
    report.status = "PASS";
  } catch (error) {
    report.error = String(error.stack);
    report.messages = choices.messages;
    throw error;
  } finally {
    files.dispose();
    previews.dispose();
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  }
}
