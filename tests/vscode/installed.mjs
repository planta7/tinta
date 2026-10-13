import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testAuthoring } from "./authoring.mjs";
import { installedWorkflow } from "./installed-workflow.mjs";
import { checkIpcWatchdog } from "../consumer/ipc-watchdog.mjs";
import { measureInstalled } from "./installed-performance.mjs";
import { traceCompletionLatency } from "./completion-latency.mjs";
import { openInstalledPreview } from "./installed-preview.mjs";

const root = process.env.TINTA_INSTALLED_ROOT;
const wait = (ms) => new Promise((accept) => setTimeout(accept, ms));
export async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error(message);
}
export async function open(name, text) {
  const path = join(root, "workspace", name);
  await writeFile(path, text);
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  return document;
}
export async function run() {
  const report = {
    status: "FAIL",
    vscode: vscode.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    trusted: vscode.workspace.isTrusted,
    groups: [],
  };
  let latency;
  try {
    const extension = vscode.extensions.getExtension(
      process.env.TINTA_INSTALLED_ID,
    );
    assert.ok(extension, "VSIX was not installed.");
    assert.ok(extension.extensionPath.startsWith(join(root, "extensions")));
    // ExtensionMode belongs to ExtensionContext, not the public Extension object.
    // Verify the installed VSIX registration rather than a development-path load.
    const registrations = JSON.parse(
      await readFile(join(root, "extensions/extensions.json"), "utf8"),
    );
    const registration = registrations.find(
      (item) => item.identifier.id === extension.id,
    );
    assert.ok(registration, "Missing installed extension registration.");
    assert.equal(registration.metadata.source, "vsix");
    assert.equal(registration.version, extension.packageJSON.version);
    assert.equal(
      vscode.Uri.file(extension.extensionPath).fsPath,
      vscode.Uri.file(join(root, "extensions", registration.relativeLocation))
        .fsPath,
    );
    assert.equal(
      extension.packageJSON.version,
      process.env.TINTA_INSTALLED_VERSION,
    );
    assert.equal(vscode.version, "1.141.0");
    report.identity = JSON.parse(
      await readFile(
        join(extension.extensionPath, "build-identity.json"),
        "utf8",
      ),
    );
    if (process.env.TINTA_INSTALLED_PERFORMANCE === "true")
      latency = traceCompletionLatency(
        join(extension.extensionPath, "dist/server.mjs"),
      );
    await extension.activate();
    report.watchdog = await checkIpcWatchdog(
      join(extension.extensionPath, "dist/server.mjs"),
      join(root, "watchdog"),
    );
    report.groups.push(
      "installed IPC server watchdog and production worker restart",
    );
    report.groups.push(
      "installed production extension in isolated profile; no checkout runtime dependencies",
    );
    const document = await open("diagnostics.tinta", "😀 {{ missing }}\n");
    await vscode.commands.executeCommand("tinta.check");
    await until(
      () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .some((item) => item.code === "E_NAME_UNKNOWN"),
      "No installed diagnostics.",
    );
    const diagnostic = vscode.languages
      .getDiagnostics(document.uri)
      .find((item) => item.code === "E_NAME_UNKNOWN");
    assert.equal(diagnostic.range.start.character, 6);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, diagnostic.range, "2");
    assert.ok(await vscode.workspace.applyEdit(edit));
    await vscode.commands.executeCommand("tinta.check");
    await until(
      () => vscode.languages.getDiagnostics(document.uri).length === 0,
      "Installed diagnostic did not clear.",
    );
    report.groups.push("Unicode diagnostic and error recovery");
    await testAuthoring(open, report.groups);
    if (process.env.TINTA_INSTALLED_PERFORMANCE === "true")
      report.performance = await measureInstalled(open, latency);
    if (process.env.TINTA_INSTALLED_WORKFLOW === "true")
      await installedWorkflow(root, open, report.groups);
    const preview = await open(
      "preview.tinta",
      '@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")\nValue: {{ amount }}\n',
    );
    await openInstalledPreview(vscode);
    await vscode.window.showTextDocument(preview);
    await vscode.commands.executeCommand("tinta.resetReading");
    report.groups.push(
      "installed preview panel opens and reset command returns",
    );
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
        await vscode.commands.executeCommand(`tinta.${name}`);
      report.groups.push(
        "Restricted Mode file handlers return without opening a picker",
      );
    }
    for (const document of vscode.workspace.textDocuments.filter(
      (item) => item.isDirty,
    )) {
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    report.groups.push("all editor and preview tabs close");
    report.status = report.performance?.status === "FAIL" ? "FAIL" : "PASS";
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    if (latency) {
      latency.dispose();
      report.completionLatency = latency.report();
    }
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  assert.equal(report.status, "PASS", report.error ?? "Host budgets failed.");
}
