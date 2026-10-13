import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileController } from "../../apps/vscode/dist/files.js";
import { operate } from "../../apps/vscode/dist/artifact-worker/operation.js";
import { acquireSource } from "../../apps/vscode/dist/source.js";
import {
  ArtifactFailure,
  encodeUtf8,
} from "../../packages/types/dist/common.js";
import { openBundle } from "../../packages/artifacts/dist/index.js";

let root;
let controller;
let preview;
let worker;
let doc;
let snapshot;
let cancel;
const uri = (path, scheme = "file") => ({
  scheme,
  fsPath: path,
  toString: () => `${scheme}:${path}`,
});
const makeDocument = (text, languageId = "tinta", scheme = "untitled") => ({
  languageId,
  uri: uri(join(root, "source.tinta"), scheme),
  version: 1,
  getText: () => text,
});
const source = (document) =>
  acquireSource(encodeUtf8(document.getText()), document.getText(), {
    uri: document.uri.toString(),
    documentInstance: "a".repeat(32),
    editorVersion: document.version,
    sourceRevision: 0,
  });
const perform = (name) => vscode.handlers[`tinta.${name}`]();
const lastWarning = () =>
  vscode.window.showWarningMessage.mock.calls.at(-1)?.[0];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tinta-native-files-"));
  vscode.workspace.isTrusted = true;
  doc = makeDocument(
    '# Source\n@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")\nValue: {{ amount }}\n',
  );
  snapshot = source(doc);
  vscode.window.activeTextEditor = { document: doc };
  vscode.window.showWarningMessage
    .mockReset()
    .mockImplementation(async (_text, _options, choice) => choice);
  vscode.window.showErrorMessage.mockReset();
  vscode.window.showInformationMessage = vi.fn(async (_text, choice) => choice);
  vscode.window.showQuickPick = vi.fn(async () => "Authored initial answers");
  vscode.window.showSaveDialog = vi.fn(async () =>
    uri(join(root, "result.html")),
  );
  vscode.window.showOpenDialog = vi.fn();
  vscode.window.withProgress = vi.fn(async (_options, work) =>
    work(
      {},
      {
        onCancellationRequested: (callback) => {
          cancel = callback;
          return { dispose() {} };
        },
      },
    ),
  );
  preview = {
    canAdopt: vi.fn(),
    activeDocument: vi.fn(),
    source: vi.fn(async () => snapshot),
    matches: vi.fn(
      (document, value) =>
        document === doc &&
        value === snapshot &&
        document.version === value.identity.editorVersion,
    ),
    resources: vi.fn(),
    adopt: vi.fn(async (document, bytes) => {
      doc = document;
      snapshot = acquireSource(bytes, document.getText(), {
        ...snapshot.identity,
        uri: document.uri.toString(),
        editorVersion: document.version,
      });
    }),
    reading: vi.fn(async () => ({
      controls: { amount: 7 },
      current: () => true,
    })),
  };
  worker = vi.fn(async (request) => {
    const result = await operate(request);
    if (result.kind === "error")
      throw new ArtifactFailure(result.code, result.message);
    return result;
  });
  controller = new FileController(preview, worker);
});
afterEach(async () => {
  controller.dispose();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("native local file commands", () => {
  it("enforces Restricted Mode in every handler without reading or writing", async () => {
    vscode.workspace.isTrusted = false;
    for (const command of [
      "selectImageRoot",
      "refreshImages",
      "enrichMarkdown",
      "openSourceBundle",
      "saveSourceBundle",
      "exportInteractive",
      "exportStatic",
    ])
      await perform(command);
    expect(worker).not.toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(7);
    expect(await readdir(root)).toEqual([]);
  });

  it("exports the unsaved source with explicit initial or current answers", async () => {
    await perform("exportStatic");
    expect(await readFile(join(root, "result.html"), "utf8")).toContain(
      "Value: 2",
    );
    vscode.window.showQuickPick.mockResolvedValue("Current preview answers");
    await perform("exportStatic");
    expect(await readFile(join(root, "result.html"), "utf8")).toContain(
      "Value: 7",
    );
    expect(preview.reading).toHaveBeenCalledWith(doc, snapshot);
    expect(doc.getText()).toContain("amount = 2");
    await perform("exportInteractive");
    const html = await readFile(join(root, "result.html"), "utf8");
    expect(html).toContain("tinta-interactive");
    expect(html).toContain("Hidden content is not private");
    expect(html).not.toContain(root);
  });

  it("packs authored defaults and round-trips a validated in-memory bundle", async () => {
    await perform("saveSourceBundle");
    const opened = await openBundle(await readFile(join(root, "result.html")));
    expect(opened.ok).toBe(true);
    expect(new TextDecoder().decode(opened.value.source.bytes)).toContain(
      "amount = 2",
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    const created = makeDocument(
      new TextDecoder().decode(opened.value.source.bytes),
    );
    controller.createDocument = vi.fn(async () => created);
    vscode.window.showOpenDialog.mockResolvedValue([
      uri(join(root, "result.html")),
    ]);
    await perform("openSourceBundle");
    expect(controller.createDocument).toHaveBeenCalled();
    expect(controller.resources.get(created).origin).toBe(
      join(root, "result.html"),
    );
    expect(await readdir(root)).toEqual(["result.html"]);
  });

  it("rejects malformed bundles before changing a buffer", async () => {
    await writeFile(join(root, "bad.zip"), "not a ZIP");
    vscode.window.showOpenDialog.mockResolvedValue([
      uri(join(root, "bad.zip")),
    ]);
    controller.createDocument = vi.fn();
    await perform("openSourceBundle");
    expect(controller.createDocument).not.toHaveBeenCalled();
    expect(lastWarning()).toMatch(/E_BUNDLE/);
    expect(doc.getText()).toContain("# Source");
  });

  it("keeps static hidden images optional while interactive export requires them", async () => {
    doc = makeDocument(
      "@when false\nHidden secret ![Hidden](missing.png)\n@end\nVisible\n",
    );
    snapshot = source(doc);
    vscode.window.activeTextEditor = { document: doc };
    await perform("exportStatic");
    const html = await readFile(join(root, "result.html"), "utf8");
    expect(html).toContain("Visible");
    expect(html).not.toContain("Hidden secret");
    await perform("exportInteractive");
    expect(lastWarning()).toMatch(/E_ASSET_MISSING/);
    expect(await readFile(join(root, "result.html"), "utf8")).toBe(html);
  });

  it("selects and refreshes explicit Unicode roots without implicit source-directory grants", async () => {
    doc = makeDocument("![Pixel](photo%20%C3%B1.png)\n");
    snapshot = source(doc);
    vscode.window.activeTextEditor = { document: doc };
    const fixture = await readFile(
      "examples/assets/36c907715b80d7cdad0e196256966a3353b771387aefb1116d8769dacc81b675.png",
    );
    await writeFile(join(root, "photo ñ.png"), fixture);
    await perform("exportInteractive");
    expect(lastWarning()).toMatch(/E_ASSET_MISSING/);
    vscode.window.showOpenDialog.mockResolvedValue([uri(root)]);
    await perform("selectImageRoot");
    expect(controller.resources.get(doc).assets.size).toBe(1);
    expect(preview.resources).toHaveBeenCalled();
    await perform("refreshImages");
    expect(controller.resources.get(doc).revision).toBe(2);
    await perform("exportInteractive");
    expect(await readFile(join(root, "result.html"), "utf8")).toContain(
      "image/png",
    );
    await rm(join(root, "photo ñ.png"));
    await symlink(join(root, "result.html"), join(root, "photo ñ.png"));
    await perform("refreshImages");
    expect(lastWarning()).toMatch(/E_ASSET_PATH/);
    expect(controller.resources.get(doc).revision).toBe(3);
    expect(controller.resources.get(doc).assets.size).toBe(0);
  });

  it("rejects source aliases, originating Markdown and read-only outputs", async () => {
    doc = makeDocument(doc.getText(), "tinta", "file");
    snapshot = source(doc);
    vscode.window.activeTextEditor = { document: doc };
    await writeFile(doc.uri.fsPath, doc.getText());
    vscode.window.showSaveDialog.mockResolvedValue(uri(doc.uri.fsPath));
    await perform("exportStatic");
    expect(lastWarning()).toContain("replace an input");
    const output = join(root, "link.html");
    await symlink(doc.uri.fsPath, output);
    vscode.window.showSaveDialog.mockResolvedValue(uri(output));
    await perform("exportStatic");
    expect(lastWarning()).toContain("replace an input");
    await rm(output);
    await writeFile(output, "KEEP");
    await chmod(output, 0o444);
    await perform("exportStatic");
    expect(lastWarning()).toContain("read-only");
    expect(await readFile(output, "utf8")).toBe("KEEP");
    await chmod(output, 0o644);
    controller.resources.set(doc, {
      instance: snapshot.identity.documentInstance,
      assets: new Map(),
      revision: 1,
      origin: output,
    });
    await perform("saveSourceBundle");
    expect(lastWarning()).toContain("replace an input");
  });

  it("cancels source edits, changed reader answers and trust loss before commit", async () => {
    await writeFile(join(root, "result.html"), "PRIOR");
    const operation = worker.getMockImplementation();
    for (const effect of [
      () => {
        doc.version++;
      },
      () => {
        vscode.workspace.isTrusted = false;
      },
      () => {
        cancel();
      },
      () => {
        controller.release(doc.uri.toString());
      },
    ]) {
      doc.version = snapshot.identity.editorVersion;
      vscode.workspace.isTrusted = true;
      worker.mockImplementation(async (request, signal) => {
        const reply = await operation(request, signal);
        if (request.kind === "produce") effect();
        return reply;
      });
      await perform("exportStatic");
      expect(await readFile(join(root, "result.html"), "utf8")).toBe("PRIOR");
    }
    worker.mockImplementation(operation);
    vscode.workspace.isTrusted = true;
    doc.version = snapshot.identity.editorVersion;
    vscode.window.showQuickPick.mockResolvedValue("Current preview answers");
    preview.reading.mockResolvedValue({
      controls: { amount: 7 },
      current: () => false,
    });
    await perform("exportStatic");
    expect(lastWarning()).toContain("answers changed");
    expect(await readdir(root)).toEqual(["result.html"]);
  });

  it("does not replace a competing output created during generation", async () => {
    const operation = worker.getMockImplementation();
    worker.mockImplementation(async (request, signal) => {
      const result = await operation(request, signal);
      if (request.kind === "produce")
        await writeFile(join(root, "result.html"), "COMPETING");
      return result;
    });
    await perform("exportStatic");
    expect(await readFile(join(root, "result.html"), "utf8")).toBe("COMPETING");
    expect(lastWarning()).toMatch(/E_OUTPUT_EXISTS|changed/);
    expect(await readdir(root)).toEqual(["result.html"]);
  });

  it("honors every native selection cancellation", async () => {
    vscode.window.showOpenDialog.mockResolvedValue(undefined);
    await perform("selectImageRoot");
    await perform("openSourceBundle");
    vscode.window.showQuickPick.mockResolvedValue(undefined);
    await perform("exportStatic");
    vscode.window.showQuickPick.mockResolvedValue("Authored initial answers");
    vscode.window.showWarningMessage.mockResolvedValue(undefined);
    await perform("exportInteractive");
    vscode.window.showWarningMessage.mockResolvedValue("Export");
    vscode.window.showSaveDialog.mockResolvedValue(undefined);
    await perform("exportStatic");
    expect(await readdir(root)).toEqual([]);
  });

  it("reports unsupported documents, missing roots and unverified/current state", async () => {
    await perform("refreshImages");
    expect(lastWarning()).toContain("Select an image root");
    preview.source.mockRejectedValue(new Error("private bytes"));
    await perform("exportStatic");
    expect(lastWarning()).toContain("Source is unverified");
    preview.source.mockResolvedValue(snapshot);
    preview.reading.mockRejectedValue(new Error("no preview"));
    vscode.window.showQuickPick.mockResolvedValue("Current preview answers");
    await perform("exportStatic");
    expect(lastWarning()).toContain("matching, valid preview");
    vscode.window.activeTextEditor = undefined;
    await perform("exportStatic");
    expect(lastWarning()).toContain("Select a local tinta");
  });

  it("redacts unexpected failures and releases a revoked grant", async () => {
    worker.mockRejectedValue(new Error("SECRET SOURCE AND PATH"));
    await perform("saveSourceBundle");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(
        /^File operation failed\. Incident: [a-f0-9]{32}\.$/,
      ),
    );
    controller.resources.set(doc, {
      instance: snapshot.identity.documentInstance,
      revision: 1,
      assets: new Map(),
    });
    vi.useFakeTimers();
    controller.dispose();
    controller = new FileController(preview, worker);
    controller.resources.set(doc, {
      instance: snapshot.identity.documentInstance,
      revision: 1,
      assets: new Map(),
    });
    vscode.workspace.isTrusted = false;
    await vi.advanceTimersByTimeAsync(201);
    expect(controller.resources.size).toBe(0);
  });
  it("rejects changed disk images and resource revisions before committing output", async () => {
    doc = makeDocument("![Image](photo.png)");
    snapshot = source(doc);
    vscode.window.activeTextEditor = { document: doc };
    const rasters = JSON.parse(
      await readFile("tests/fixtures/rasters.json", "utf8"),
    ).rasters;
    const first = Buffer.from(rasters[0].base64, "base64");
    const second = Buffer.from(rasters[1].base64, "base64");
    const image = join(root, "photo.png");
    await writeFile(image, first);
    vscode.window.showOpenDialog.mockResolvedValue([uri(root)]);
    await perform("selectImageRoot");
    await writeFile(image, second);
    await perform("exportStatic");
    expect(lastWarning()).toContain("Images changed; refresh");
    await perform("refreshImages");
    const operation = worker.getMockImplementation();
    worker.mockImplementation(async (request, signal) => {
      const result = await operation(request, signal);
      if (request.kind === "produce") await writeFile(image, first);
      return result;
    });
    await perform("exportStatic");
    expect(lastWarning()).toContain("Images changed during export");
    expect(await readdir(root)).toEqual(["photo.png"]);
    worker.mockImplementation(operation);
    await perform("refreshImages");
    worker.mockImplementation(async (request, signal) => {
      const result = await operation(request, signal);
      if (request.kind === "produce")
        controller.resources.set(doc, {
          ...controller.resources.get(doc),
          revision: 99,
        });
      return result;
    });
    await perform("exportStatic");
    expect(lastWarning()).toContain("Image grant changed");
    expect(await readdir(root)).toEqual(["photo.png"]);
  });

  it("previews enrichment and preserves Markdown when cancelled or superseded", async () => {
    doc = makeDocument("Literal {{ amount }}", "markdown", "file");
    vscode.window.activeTextEditor = { document: doc };
    vscode.commands.executeCommand = vi.fn(async () => {});
    controller.createDocument = vi.fn(async () => {
      const copy = makeDocument("Copied");
      snapshot = source(copy);
      return copy;
    });
    await perform("enrichMarkdown");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      expect.stringContaining("proposed copy"),
    );
    expect(controller.createDocument).toHaveBeenCalled();
    expect(controller.comparisons.size).toBe(0);
    expect(doc.getText()).toBe("Literal {{ amount }}");
    controller.createDocument.mockClear();
    vscode.window.showInformationMessage.mockResolvedValue(undefined);
    await perform("enrichMarkdown");
    expect(controller.createDocument).not.toHaveBeenCalled();
    vscode.window.showInformationMessage.mockImplementation(async () => {
      doc.version++;
      return "Create Separate Document";
    });
    await perform("enrichMarkdown");
    expect(lastWarning()).toContain("Markdown changed");
    expect(controller.comparisons.size).toBe(0);
  });
});
