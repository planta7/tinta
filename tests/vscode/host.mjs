import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { sourceMap, sourcePosition } from "./source-map.mjs";

const digest = (value) => createHash("sha256").update(value).digest("base64");

export async function run() {
  const root = process.env.TINTA_PROBE_ROOT;
  const report = {
    vscode: vscode.version,
    runtime: process.versions,
    platform: process.platform,
    architecture: process.arch,
    sources: [],
  };
  const workerPath = join(root, "analysis.mjs");
  try {
    assert.equal(vscode.version, "1.141.0");
    const product = JSON.parse(
      await readFile(join(vscode.env.appRoot, "product.json"), "utf8"),
    );
    report.commit = product.commit;
    assert.equal(report.commit, "2a59476c9bfcb90b3ddc372c36762471b7dfad1c");
    const extension = vscode.extensions.getExtension(
      "tinta-local.tinta-host-probe",
    );
    await extension.activate();
    assert.equal(extension.isActive, true);
    report.esmActivation = true;
    const fixtures = [
      ["bom", Buffer.from("\uFEFF# A\r\n😀 B\r\n")],
      ["lf", Buffer.from("# A\n😀 B\n")],
      ["crlf", Buffer.from("# A\r\n😀 B\r\n")],
      ["cr", Buffer.from("# A\r😀 B\r")],
      ["mixed", Buffer.from("# A\r\n😀 B\rC\n")],
      ["replacement", Buffer.from("A � B\n")],
      ["invalid", Buffer.from([0x41, 0xc3, 0x28, 0x0a])],
    ];
    for (const [name, bytes] of fixtures) {
      const file = join(root, `${name}.tinta`);
      await writeFile(file, bytes);
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(file),
      );
      let strict = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        strict = false;
      }
      const text = doc.getText();
      const positions = [];
      for (let offset = 0; offset <= text.length; offset++) {
        const pos = doc.positionAt(offset);
        positions.push([offset, pos.line, pos.character, doc.offsetAt(pos)]);
      }
      if (strict) {
        const model = sourceMap(bytes, text);
        for (let offset = 0; offset <= model.text.length; offset++) {
          const mapped = sourcePosition(model, offset);
          const native = doc.positionAt(
            doc.offsetAt(new vscode.Position(mapped.line, mapped.character)),
          );
          assert.equal(native.line, mapped.line);
          assert.equal(native.character, mapped.character);
        }
        const astral = text.indexOf("😀");
        if (astral >= 0) {
          const before = doc.positionAt(astral);
          const after = doc.positionAt(astral + 2);
          assert.equal(after.character - before.character, 2);
        }
      }
      const original = Buffer.from(bytes);
      await doc.save();
      assert.deepEqual(await readFile(file), original);
      const editor = await vscode.window.showTextDocument(doc);
      const change = onceChange(doc);
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "X"));
      const event = await change;
      report.sources.push({
        name,
        strict,
        originalHex: bytes.toString("hex"),
        text,
        eol: doc.eol,
        positions,
        version: doc.version,
        changes: event.contentChanges.map((item) => ({
          offset: item.rangeOffset,
          length: item.rangeLength,
          text: item.text,
        })),
      });
      await doc.save();
      report.sources.at(-1).savedHex = (await readFile(file)).toString("hex");
    }
    for (const name of ["bom", "lf", "crlf", "replacement"]) {
      const entry = report.sources.find((item) => item.name === name);
      const originalText = Buffer.from(entry.originalHex, "hex").toString(
        "utf8",
      );
      const expected = originalText.startsWith("\uFEFF")
        ? "\uFEFFX" + originalText.slice(1)
        : "X" + originalText;
      assert.equal(
        Buffer.from(entry.savedHex, "hex").toString("utf8"),
        expected,
      );
    }
    for (const name of ["cr", "mixed"]) {
      const entry = report.sources.find((item) => item.name === name);
      assert.equal(entry.text.includes("\r\n"), true);
      assert.equal(
        Buffer.from(entry.savedHex, "hex").toString("utf8"),
        "X" + entry.text,
      );
      assert.notEqual(entry.savedHex, "58" + entry.originalHex);
    }
    assert.equal(
      report.sources.find((x) => x.name === "invalid").strict,
      false,
    );
    assert.equal(
      report.sources.find((x) => x.name === "replacement").strict,
      true,
    );

    let worker = new Worker(workerPath);
    try {
      let response = once(worker, "message");
      worker.postMessage("compile");
      const [compiled] = await response;
      assert.equal(compiled.kind, "compiled");
      report.worker = { node: compiled.node, esmCompile: true };
      response = once(worker, "message");
      worker.postMessage("stall");
      assert.equal((await response)[0].kind, "entered");
      const preview = previewProbe(root, compiled.program);
      // Observe UI-thread work completing while the analysis thread spins.
      const nativeStarted = performance.now();
      const liveDocument = await vscode.workspace.openTextDocument({
        content: "A",
      });
      const liveEditor = await vscode.window.showTextDocument(liveDocument);
      assert.equal(
        await liveEditor.edit((edit) =>
          edit.insert(new vscode.Position(0, 1), "B"),
        ),
        true,
      );
      assert.equal(liveDocument.getText(), "AB");
      report.worker.nativeEditMs = performance.now() - nativeStarted;
      assert.ok(report.worker.nativeEditMs < 1000);
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 25);
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await worker.terminate();
      clearInterval(ticker);
      report.worker.terminationMs = performance.now() - started;
      report.worker.responsiveTicks = ticks;
      assert.ok(ticks >= 50);
      assert.ok(report.worker.terminationMs < 4000);
      worker = new Worker(workerPath);
      response = once(worker, "message");
      worker.postMessage("compile");
      assert.equal((await response)[0].kind, "compiled");
      report.worker.restart = true;
      report.preview = await preview;
      report.inheritedCsp = await previewProbe(root, compiled.program, false);
    } finally {
      await worker.terminate();
    }
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = String(error.stack ?? error);
    throw error;
  } finally {
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  }
}

function onceChange(doc) {
  return new Promise((resolve) => {
    const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === doc && event.contentChanges.length) {
        disposable.dispose();
        resolve(event);
      }
    });
  });
}

async function previewProbe(root, program, allowReader = true) {
  const preview = await readFile(join(root, "preview.html"), "utf8");
  const outer = await readFile(join(root, "outer.js"), "utf8");
  const audit = await readFile(join(root, "inner-audit.js"), "utf8");
  const innerHash = /script-src 'sha256-([^']+)'/.exec(preview)[1];
  const instrumented = preview
    .replace(
      `script-src 'sha256-${innerHash}'`,
      `script-src 'sha256-${innerHash}' 'sha256-${digest(audit)}'`,
    )
    .replace("</body>", `<script>${audit}</script></body>`);
  const payload = JSON.stringify({
    preview: instrumented,
    program,
    allowReader,
  }).replace(/</g, "\\u003c");
  const code = `const payload = ${payload};\n${outer}`;
  const panel = vscode.window.createWebviewPanel(
    "tinta.probe",
    "Tinta host probe",
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [], enableCommandUris: false },
  );
  let listener;
  let timer;
  try {
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Webview probe timed out")),
        15000,
      );
      listener = panel.webview.onDidReceiveMessage((message) => {
        if (message.kind === "result") resolve(message);
      });
    });
    panel.webview.html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none';
      script-src 'sha256-${digest(code)}' ${allowReader ? `'sha256-${innerHash}'` : ""} 'sha256-${digest(audit)}';
      style-src 'unsafe-inline'; img-src data: blob:; frame-src 'self';
      connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
      </head><body><script>${code}</script></body></html>`;
    const result = await completed;
    assert.equal(result.loaded, allowReader);
    assert.equal(result.opaque, true);
    assert.equal(result.parentDenied, true);
    assert.equal(result.storageDenied, true);
    assert.equal(result.vscodeAbsent, true);
    assert.equal(result.fileDenied, true);
    assert.equal(result.networkDenied, true);
    assert.equal(result.unhashedScriptBlocked, true);
    assert.equal(result.protocolRejected, allowReader);
    if (!allowReader) assert.equal(result.inheritedReaderBlock, true);
    return result;
  } finally {
    clearTimeout(timer);
    listener?.dispose();
    panel.dispose();
  }
}
