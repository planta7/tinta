import * as vscode from "vscode";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  atomicWrite,
  assertAssetRoot,
  identity,
  readAssets,
  readBounded,
  HostFailure,
} from "@tinta-lang/local-files";
import {
  ArtifactFailure,
  decodeUtf8,
  encodeUtf8,
  limits,
} from "@tinta-lang/types/common";
import { validateAssets } from "@tinta-lang/artifacts";
import type { Asset, AssetStore, ControlState } from "@tinta-lang/types";
import { runArtifact } from "./artifacts.js";
import type { ArtifactRequest, ArtifactReply } from "./artifact-protocol.js";
import type { PreviewController } from "./preview.js";
import type { NativeSource } from "./source.js";

interface Resources {
  readonly instance: string;
  readonly revision: number;
  readonly assets: AssetStore;
  readonly root?: string;
  readonly origin?: string;
}

type Runner = (
  request: ArtifactRequest,
  signal: AbortSignal,
) => Promise<ArtifactReply>;

export class FileController implements vscode.Disposable {
  private readonly resources = new Map<vscode.TextDocument, Resources>();
  private readonly listeners: vscode.Disposable[] = [];
  private readonly comparisons = new Map<string, string>();
  private readonly trustTimer: ReturnType<typeof setInterval>;
  private active?: {
    controller: AbortController;
    document?: vscode.TextDocument;
  };

  constructor(
    private readonly preview: PreviewController,
    private readonly worker: Runner = runArtifact,
  ) {
    this.trustTimer = setInterval(() => {
      if (!vscode.workspace.isTrusted) this.revoke();
    }, 200);
    const command = (name: string, action: () => Promise<void>) =>
      vscode.commands.registerCommand(name, () => this.run(action));
    this.listeners.push(
      command("tinta.selectImageRoot", () => this.selectRoot()),
      command("tinta.refreshImages", () => this.refresh()),
      command("tinta.enrichMarkdown", () => this.enrich()),
      command("tinta.openSourceBundle", () => this.openBundle()),
      command("tinta.saveSourceBundle", () => this.export("bundle")),
      command("tinta.exportInteractive", () => this.export("interactive")),
      command("tinta.exportStatic", () => this.export("static")),
      vscode.workspace.registerTextDocumentContentProvider("tinta-comparison", {
        provideTextDocumentContent: (uri) =>
          this.comparisons.get(uri.toString()) ?? "",
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.active?.document === event.document)
          this.active.controller.abort();
      }),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.release(document.uri.toString()),
      ),
    );
  }

  private trusted(): void {
    if (!vscode.workspace.isTrusted)
      throw new ArtifactFailure(
        "E_IO",
        "This command requires a trusted local workspace and an explicit file or root choice.",
      );
  }

  private checkpoint(): void {
    this.trusted();
    this.active!.controller.signal.throwIfAborted();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.active) {
      void vscode.window.showWarningMessage(
        "Another Tinta file operation is running.",
      );
      return;
    }
    try {
      this.trusted();
      this.active = { controller: new AbortController() };
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tinta local files",
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const subscription = cancellation.onCancellationRequested(() =>
            this.active?.controller.abort(),
          );
          try {
            await action();
          } finally {
            subscription.dispose();
          }
        },
      );
    } catch (error) {
      if (this.active?.controller.signal.aborted) {
        void vscode.window.showInformationMessage(
          "Operation cancelled; source and prior files preserved.",
        );
      } else if (
        error instanceof ArtifactFailure ||
        error instanceof HostFailure
      ) {
        void vscode.window.showWarningMessage(
          `${error.code}: ${error.message}`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `File operation failed. Incident: ${randomBytes(16).toString("hex")}.`,
        );
      }
    } finally {
      delete this.active;
      if (!vscode.workspace.isTrusted) this.revoke();
    }
  }

  private document(language = "tinta"): vscode.TextDocument {
    const document =
      vscode.window.activeTextEditor?.document ??
      (language === "tinta" ? this.preview.activeDocument() : undefined);
    if (
      !document ||
      document.languageId !== language ||
      !["file", "untitled"].includes(document.uri.scheme)
    )
      throw new ArtifactFailure(
        "E_IO",
        `Select a local ${language} document first.`,
      );
    this.active!.document = document;
    return document;
  }

  private async source(document: vscode.TextDocument): Promise<NativeSource> {
    try {
      return await this.preview.source(document);
    } catch {
      throw new ArtifactFailure(
        "E_EXPORT_INVALID",
        "Source is unverified. Reopen it or explicitly create a separate UTF-8/LF copy.",
      );
    }
  }

  private current(document: vscode.TextDocument, source: NativeSource): void {
    this.checkpoint();
    if (!this.preview.matches(document, source))
      throw new ArtifactFailure("E_IO", "Source changed; output cancelled.");
  }

  private get(document: vscode.TextDocument, source: NativeSource): Resources {
    const value = this.resources.get(document);
    if (value?.instance === source.identity.documentInstance) return value;
    const empty: Resources = {
      instance: source.identity.documentInstance,
      revision: 0,
      assets: new Map(),
    };
    this.resources.set(document, empty);
    return empty;
  }

  private install(document: vscode.TextDocument, resources: Resources): void {
    const unique = new Map<string, number>();
    for (const [other, value] of [
      ...this.resources,
      [document, resources] as const,
    ]) {
      if (other === document && value !== resources) continue;
      for (const asset of value.assets.values())
        unique.set(asset.sha256, asset.bytes.length);
    }
    if (
      [...unique.values()].reduce((sum, bytes) => sum + bytes, 0) >
      100 * 1024 * 1024
    )
      throw new ArtifactFailure(
        "E_LIMIT",
        "Local image cache capacity exceeded.",
      );
    this.resources.set(document, resources);
    this.preview.resources(document, resources.assets, resources.revision);
  }

  private async inspect(
    source: NativeSource,
    format: "bundle" | "interactive" | "static",
    baseline?: ControlState,
  ): Promise<readonly string[]> {
    const result = await this.worker(
      {
        kind: "inspect",
        source: {
          text: source.text,
          uri: source.identity.uri,
          profile: "tinta",
        },
        format,
        assets: new Map(),
        ...(baseline ? { baseline } : {}),
      },
      this.active!.controller.signal,
    );
    this.checkpoint();
    if (result.kind !== "inspect")
      throw new Error("Unexpected artifact reply.");
    return result.destinations;
  }

  private async selectRoot(): Promise<void> {
    const document = this.document();
    const source = await this.source(document);
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Select this document's local image root",
    });
    if (!chosen?.[0]) return;
    this.current(document, source);
    if (chosen[0].scheme !== "file")
      throw new ArtifactFailure("E_IO", "Choose a local directory.");
    await this.loadRoot(document, source, chosen[0].fsPath);
  }

  private async refresh(): Promise<void> {
    const document = this.document();
    const source = await this.source(document);
    const resources = this.get(document, source);
    if (!resources.root)
      throw new ArtifactFailure(
        "E_ASSET_MISSING",
        "Select an image root first. Bundled images are retained in memory.",
      );
    await this.loadRoot(document, source, resources.root);
  }

  private async loadRoot(
    document: vscode.TextDocument,
    source: NativeSource,
    root: string,
  ): Promise<void> {
    const destinations = await this.inspect(source, "interactive");
    await assertAssetRoot(root);
    const available = new Map<string, Asset>();
    const warnings = new Set<string>();
    const hashes = new Set<string>();
    let totalBytes = 0;
    let unavailable = 0;
    for (const destination of new Set(destinations)) {
      this.current(document, source);
      try {
        const loaded = await readAssets(
          [destination],
          root,
          this.active!.controller.signal,
        );
        for (const [key, asset] of loaded) {
          if (!hashes.has(asset.sha256)) {
            hashes.add(asset.sha256);
            totalBytes += asset.bytes.length;
          }
          if (
            hashes.size > limits.assetCount ||
            totalBytes > limits.totalAssetBytes
          )
            throw new ArtifactFailure(
              "E_LIMIT",
              "Document image limits exceeded.",
            );
          available.set(key, asset);
        }
      } catch (error) {
        if (
          !(error instanceof ArtifactFailure) ||
          !error.code.startsWith("E_ASSET_")
        )
          throw error;
        warnings.add(error.code);
        unavailable++;
      }
    }
    const assets = validateAssets(available);
    this.current(document, source);
    const before = this.get(document, source);
    this.install(document, {
      ...before,
      root,
      assets,
      revision: before.revision + 1,
    });
    if (unavailable) {
      void vscode.window.showWarningMessage(
        `${[...warnings].join(", ")}: ${unavailable} image references are unavailable. Preview uses placeholders; export checks its required images.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Validated ${assets.size} local image references.`,
      );
    }
  }

  private async createDocument(
    bytes: Uint8Array,
  ): Promise<vscode.TextDocument> {
    this.checkpoint();
    this.preview.canAdopt(bytes);
    const text = decodeUtf8(bytes);
    const uri = vscode.Uri.parse(
      `untitled:Tinta-${randomBytes(8).toString("hex")}.tinta`,
    );
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), text.replace(/^\uFEFF/, ""));
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error("Could not create the document.");
    await vscode.languages.setTextDocumentLanguage(document, "tinta");
    await this.preview.adopt(document, bytes);
    await vscode.window.showTextDocument(document);
    return document;
  }

  private async openBundle(): Promise<void> {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      title: "Open Source Bundle",
      filters: { "Tinta source bundle": ["tinta.zip"] },
    });
    if (!chosen?.[0]) return;
    this.checkpoint();
    if (chosen[0].scheme !== "file")
      throw new ArtifactFailure("E_IO", "Choose a local source bundle.");
    const bytes = await readBounded(chosen[0].fsPath, limits.bundleBytes);
    const result = await this.worker(
      { kind: "open", bytes },
      this.active!.controller.signal,
    );
    this.checkpoint();
    if (result.kind !== "open") throw new Error("Unexpected artifact reply.");
    const currentBytes = new Map<string, number>();
    for (const value of this.resources.values())
      for (const asset of value.assets.values())
        currentBytes.set(asset.sha256, asset.bytes.length);
    for (const asset of result.bundle.assets.values())
      currentBytes.set(asset.sha256, asset.bytes.length);
    if (
      [...currentBytes.values()].reduce((sum, length) => sum + length, 0) >
      100 * 1024 * 1024
    )
      throw new ArtifactFailure(
        "E_LIMIT",
        "Local image cache capacity exceeded.",
      );
    const document = await this.createDocument(result.bundle.source.bytes!);
    const source = await this.source(document);
    this.install(document, {
      instance: source.identity.documentInstance,
      revision: 1,
      assets: result.bundle.assets,
      origin: chosen[0].fsPath,
    });
  }

  private async enrich(): Promise<void> {
    const document = this.document("markdown");
    const version = document.version;
    const text = document.getText();
    if (encodeUtf8(text).length > limits.sourceBytes)
      throw new ArtifactFailure("E_LIMIT", "Source byte limit exceeded.");
    const result = await this.worker(
      {
        kind: "enrich",
        source: { text, uri: document.uri.toString(), profile: "markdown" },
      },
      this.active!.controller.signal,
    );
    this.checkpoint();
    if (result.kind !== "enrich") throw new Error("Unexpected artifact reply.");
    const id = randomBytes(16).toString("hex");
    const before = vscode.Uri.parse(`tinta-comparison:${id}/original.md`);
    const after = vscode.Uri.parse(`tinta-comparison:${id}/proposed.tinta`);
    this.comparisons.set(before.toString(), text);
    this.comparisons.set(after.toString(), result.enrichment.source);
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        "Markdown enrichment — proposed copy",
      );
      const answer = await vscode.window.showInformationMessage(
        "Review the proposed enrichment. Create a separate Tinta document? The Markdown source stays unchanged.",
        "Create Tinta Copy",
      );
      if (answer !== "Create Tinta Copy") return;
      this.checkpoint();
      if (document.version !== version)
        throw new ArtifactFailure(
          "E_IO",
          "Markdown changed during enrichment.",
        );
      const copy = await this.createDocument(
        encodeUtf8(result.enrichment.source),
      );
      const source = await this.source(copy);
      this.install(copy, {
        instance: source.identity.documentInstance,
        revision: 0,
        assets: new Map(),
        ...(document.uri.scheme === "file"
          ? { origin: document.uri.fsPath }
          : {}),
      });
    } finally {
      this.comparisons.delete(before.toString());
      this.comparisons.delete(after.toString());
    }
  }

  private async export(
    format: "bundle" | "interactive" | "static",
  ): Promise<void> {
    const document = this.document();
    const source = await this.source(document);
    let baseline: ControlState | undefined;
    let readingCurrent = () => true;
    if (format !== "bundle") {
      const choice = await vscode.window.showQuickPick(
        ["Authored initial answers", "Current preview answers"],
        { title: "Export answers" },
      );
      if (!choice) return;
      this.current(document, source);
      if (choice === "Current preview answers") {
        try {
          const reading = await this.preview.reading(document, source);
          baseline = reading.controls;
          readingCurrent = reading.current;
        } catch {
          throw new ArtifactFailure(
            "E_EXPORT_INVALID",
            "Current answers require a matching, valid preview. Retry after checking source and images.",
          );
        }
      }
      const disclosure =
        format === "interactive"
          ? "This interactive file contains the complete source, all embedded data, hidden explanations and image metadata. Hidden content is not private. It does not send data anywhere."
          : "This static file contains only the resolved visible content and images. Visible tables and figures disclose their included data; images may retain metadata.";
      if (
        (await vscode.window.showWarningMessage(
          disclosure,
          { modal: true },
          "Export",
        )) !== "Export"
      )
        return;
    }
    this.current(document, source);
    const resources = this.get(document, source);
    const destinations = await this.inspect(source, format, baseline);
    let assets = resources.assets;
    if (resources.root) {
      const loaded = await readAssets(
        destinations,
        resources.root,
        this.active!.controller.signal,
      );
      if (
        [...loaded].some(
          ([key, asset]) => assets.get(key)?.sha256 !== asset.sha256,
        )
      )
        throw new ArtifactFailure(
          "E_IO",
          "Images changed; refresh local images before exporting.",
        );
      assets = loaded;
    }
    const output = await vscode.window.showSaveDialog({
      title: format === "bundle" ? "Save Source Bundle" : "Export HTML",
      saveLabel: "Write separate artifact",
      filters:
        format === "bundle"
          ? { "Tinta source bundle": ["tinta.zip"] }
          : { HTML: ["html"] },
    });
    if (!output) return;
    this.current(document, source);
    if (output.scheme !== "file")
      throw new ArtifactFailure("E_IO", "Choose a local output file.");
    const existing = await identity(output.fsPath);
    const force = !!existing;
    if (
      force &&
      (await vscode.window.showWarningMessage(
        `Replace the selected output ${basename(output.fsPath)}?`,
        { modal: true },
        "Replace",
      )) !== "Replace"
    )
      return;
    const candidate = await this.worker(
      {
        kind: "produce",
        source: {
          text: source.text,
          uri: source.identity.uri,
          profile: "tinta",
        },
        format,
        assets,
        ...(baseline ? { baseline } : {}),
      },
      this.active!.controller.signal,
    );
    if (candidate.kind !== "produce")
      throw new Error("Unexpected artifact reply.");
    const check = () => {
      this.current(document, source);
      if (this.get(document, source) !== resources)
        throw new ArtifactFailure(
          "E_IO",
          "Image grant changed; output cancelled.",
        );
      if (!readingCurrent())
        throw new ArtifactFailure(
          "E_IO",
          "Preview answers changed; output cancelled.",
        );
    };
    if (resources.root) {
      const verified = await readAssets(
        destinations,
        resources.root,
        this.active!.controller.signal,
      );
      if (
        [...verified].some(
          ([key, asset]) => assets.get(key)?.sha256 !== asset.sha256,
        )
      )
        throw new ArtifactFailure(
          "E_IO",
          "Images changed during export; output cancelled.",
        );
    }
    if (baseline) await this.preview.reading(document, source);
    check();
    const inputs = [
      ...(document.uri.scheme === "file" ? [document.uri.fsPath] : []),
      ...(resources.origin ? [resources.origin] : []),
      ...(resources.root
        ? [...assets.keys()].map((key) => join(resources.root!, key))
        : []),
    ];
    await atomicWrite(
      output.fsPath,
      candidate.artifact.bytes,
      inputs,
      force,
      this.active!.controller.signal,
      check,
      existing ?? null,
    );
    void vscode.window.showInformationMessage(
      `Wrote ${basename(output.fsPath)} (${candidate.artifact.bytes.length} bytes).`,
    );
  }

  release(uri: string): void {
    if (this.active?.document?.uri.toString() === uri)
      this.active.controller.abort();
    for (const document of this.resources.keys())
      if (document.uri.toString() === uri) this.resources.delete(document);
  }

  private revoke(): void {
    this.active?.controller.abort();
    for (const [document, value] of this.resources) {
      try {
        this.preview.resources(document, new Map(), value.revision + 1);
      } catch {
        /* The source may already have closed. */
      }
    }
    this.resources.clear();
  }

  dispose(): void {
    clearInterval(this.trustTimer);
    this.revoke();
    for (const listener of this.listeners) listener.dispose();
    this.comparisons.clear();
  }
}
