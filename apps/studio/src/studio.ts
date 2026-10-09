import { Drafts } from "./drafts.js";
import { readRoute, writeRoute } from "./navigation.js";
import { catalogDialog } from "./catalog.js";
import { createElement as h } from "react";
import { createWorkspace } from "./workspace.js";
import { action, dialog, field, node, select } from "./dialogs.js";
import { Welcome } from "./welcome.js";
import { WorkspaceHeader } from "./workspace-header.js";
import { editorOffset, sourceOffset } from "./source-buffer.js";

import { importCsv, importJson } from "@tinta/engine";
import { enrichMarkdown } from "@tinta/syntax";
import {
  createAsset,
  createStateSnapshot,
  decodeUtf8,
  exportHtml,
  imageDestinations,
  limits,
  normalizeAssetPath,
  openBundle,
  packSource,
  unwrap,
  validateAssets,
} from "@tinta/artifacts";
import type {
  Asset,
  DataImport,
  Diagnostic,
  ImportColumn,
  Session,
  SourceProfile,
} from "@tinta/types";
import { CompilerHost, type Compilation } from "./compiler-host.js";
import { SourceEditor, tokenEffect } from "./editor.js";
import { PreviewHost } from "./preview-host.js";
import {
  filenameParts,
  insertionBoundary,
  profileFor,
  reconcile,
  safeFilename,
  stem,
} from "./model.js";

import { readFile, saveFile, sourceBytes } from "./files.js";
import { token } from "./protocol.js";
import { examples, snippets, workerCode } from "./studio-runtime.js";

const {
  root,
  status,
  diagnostics,
  surface,
  tabs,
  sourcePane,
  previewContent,
  sourceHeading,
  emptyPreview,
  localNote,
} = createWorkspace();

export class Studio {
  source = "";
  checkpoint = "";
  filename = "untitled.tinta";
  profile: SourceProfile = "tinta";
  revision = 0;
  validRevision = -1;
  active = false;
  editing = false;
  tab = "source";
  pending = false;
  session: Session | undefined;
  editor: SourceEditor | undefined;
  preview: PreviewHost | undefined;
  assets = new Map<string, Asset>();
  private compiler = new CompilerHost(workerCode, (result) =>
    this.compiled(result),
  );
  private debounce?: ReturnType<typeof setTimeout>;
  private drafts = new Drafts((text) => {
    localNote.textContent = text;
    if (text.startsWith("W_RECOVERY")) this.message(text);
  });
  private recovery = this.drafts.store;
  private navigationRevision = 0;
  private documentId = token();
  private requestAfterCheck: (() => void) | undefined;
  private diagnosticList: readonly Diagnostic[] = [];

  constructor() {
    action(tabs, "Source", () => {
      this.tab = "source";
      this.render();
    });
    action(tabs, "Preview", () => {
      this.tab = "preview";
      this.render();
    });
    document.addEventListener("keydown", (event) => {
      if (
        document.querySelector("dialog[open]") ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey
      )
        return;

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (event.shiftKey) this.saveAs();
        else void this.saveSource();
      }
      if (key === "o") {
        event.preventDefault();
        this.pickOpen();
      }
      if (key === "n") {
        event.preventDefault();
        this.newDocument();
      }
      if (key === "e" && event.shiftKey) {
        event.preventDefault();
        this.exportDialog();
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (this.dirty && (!this.drafts.enabled || this.drafts.pending)) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("dragover", (event) => event.preventDefault());
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      this.chooseFiles(Array.from(event.dataTransfer?.files ?? []));
    });
    document.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || event.target.closest("dialog"))
        return;
      for (const opened of document.querySelectorAll<HTMLDetailsElement>(
        ".action-menu[open]",
      )) {
        if (!opened.contains(event.target)) opened.open = false;
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]"))
        return;
      const opened =
        document.querySelector<HTMLDetailsElement>(".action-menu[open]");
      if (opened) {
        event.preventDefault();
        opened.open = false;
        opened.querySelector("summary")?.focus();
      }
    });
    window.addEventListener("hashchange", () => void this.navigate());
    this.render();
    void this.navigate();
  }

  documentRoute(replace = false): void {
    writeRoute(
      this.active
        ? { section: "document", id: this.documentId, editing: this.editing }
        : { section: "home" },
      replace,
    );
  }

  async navigate(approved = false): Promise<void> {
    const revision = ++this.navigationRevision;
    const route = readRoute();
    for (const opened of document.querySelectorAll<HTMLDialogElement>(
      "dialog[open]",
    ))
      opened.close();
    if (!route || route.section === "home") {
      this.home();
      return;
    }
    const id = route.section === "document" ? route.id : undefined;
    if (
      route?.section === "document" &&
      this.active &&
      id === this.documentId
    ) {
      this.setEditing(route?.section === "document" && route.editing);
      return;
    }
    if (
      route?.section === "document" &&
      this.active &&
      this.dirty &&
      id !== this.documentId &&
      !approved
    ) {
      this.documentRoute(true);
      this.unsaved(() => {
        writeRoute(route, true);
        void this.navigate(true);
      });
      return;
    }
    if (id && this.drafts.enabled && (!this.active || id !== this.documentId)) {
      try {
        const copy = (await this.recovery.list()).find(
          (entry) => entry.id === id,
        );
        if (revision !== this.navigationRevision) return;
        if (copy) {
          this.open(
            copy.source,
            copy.filename,
            copy.profile,
            new Map(copy.assets),
            copy.changed !== false,
            copy.id,
          );
          if (route?.section === "document") this.setEditing(route.editing);
        } else {
          this.documentRoute(true);
          this.message(
            "This local draft is no longer available. Open a file or choose another recovery copy.",
          );
        }
      } catch {
        this.message(
          "W_RECOVERY_UNAVAILABLE: The local draft could not be restored. Open a saved source file to continue.",
        );
      }
    }
    if (route?.section === "examples") this.examples();
    if (route?.section === "recovery") this.preferences();
    if (route?.section === "snippets") {
      if (!this.active) this.open("", "untitled.tinta", "tinta");
      this.snippetDialog();
    }
  }

  home(): void {
    writeRoute({ section: "home" }, true);
    this.unsaved(
      () => {
        this.navigationRevision++;
        this.active = false;
        clearTimeout(this.debounce);
        this.revision++;
        this.pending = false;
        this.compiler.stop();
        this.preview?.destroy();
        this.session?.destroy();
        this.editor?.destroy();
        this.preview = undefined;
        this.session = undefined;
        this.editor = undefined;
        diagnostics.replaceChildren();
        writeRoute({ section: "home" });
        this.message("");
        this.render();
      },
      () => this.documentRoute(true),
    );
  }

  get dirty(): boolean {
    return this.active && this.source !== this.checkpoint;
  }

  get valid(): boolean {
    return (
      !this.pending && this.validRevision === this.revision && !!this.session
    );
  }

  message(text: string): void {
    status.textContent = text;
    status.dataset.tone = this.pending
      ? "pending"
      : this.active && !this.valid
        ? "error"
        : "ready";
  }

  error(error: unknown): void {
    this.message(
      error instanceof Error
        ? error.message
        : "Operation failed. Your source is still available.",
    );
  }

  async attempt(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.error(error);
    }
  }

  render(): void {
    const focused = document.activeElement;
    if (
      !this.valid &&
      focused instanceof HTMLButtonElement &&
      ["Export", "Save bundle"].includes(focused.textContent ?? "")
    ) {
      status.tabIndex = -1;
      status.focus();
    }
    surface.hidden = !this.active;
    surface.className = this.editing ? "editing" : "reading";
    surface.dataset.tab = this.tab;
    document.body.dataset.active = String(this.active);
    emptyPreview.hidden = this.source.length > 0;
    sourceHeading.lastElementChild!.textContent =
      this.profile === "markdown" ? "Markdown" : "tinta";
    for (const tab of tabs.querySelectorAll("button")) {
      tab.setAttribute(
        "aria-pressed",
        String(tab.textContent?.toLowerCase() === this.tab),
      );
    }
    if (!this.active) {
      root.render(
        h(Welcome, {
          newDocument: () => this.newDocument(),
          openFile: () => this.pickOpen(),
          exploreExamples: () => this.examples(),
          openExample: (name) =>
            this.open(examples[name]!, name + ".tinta", "tinta"),
          recovery: () => this.preferences(),
        }),
      );
      return;
    }
    root.render(
      h(WorkspaceHeader, {
        filename: this.filename,
        dirty: this.dirty,
        profile: this.profile,
        valid: this.valid,
        editing: this.editing,
        home: () => this.home(),
        newDocument: () => this.newDocument(),
        saveSource: () => {
          void this.saveSource();
        },
        exportDialog: () => this.exportDialog(),
        pickOpen: () => this.pickOpen(),
        saveAs: () => this.saveAs(),
        rename: () => this.rename(),
        bundle: () => {
          void this.bundle();
        },
        importDialog: () => this.importDialog(),
        snippetDialog: () => this.snippetDialog(),
        check: () => this.check(),
        resetReading: () => {
          this.session?.reset();
          this.preview?.reset();
        },
        examples: () => this.examples(),
        preferences: () => this.preferences(),
        enrich: () => this.enrich(),
        setEditing: (editing) => this.setEditing(editing),
      }),
    );
  }

  setEditing(editing: boolean): void {
    if (this.editing === editing) return;
    this.editing = editing;
    this.documentRoute();
    if (!editing) this.check();
    this.render();
  }

  newDocument(): void {
    this.unsaved(() => {
      this.tab = "source";
      this.open("", "untitled.tinta", "tinta", new Map(), false, token(), true);
      this.editor?.view.focus();
    });
  }

  open(
    source: string,
    filename: string,
    profile: SourceProfile,
    assets = new Map<string, Asset>(),
    recovered = false,
    documentId = token(),
    editing = false,
  ): void {
    clearTimeout(this.debounce);
    this.drafts.cancel();
    this.compiler.stop();
    this.preview?.destroy();
    this.session?.destroy();
    this.editor?.destroy();
    this.session = undefined;
    this.preview = undefined;
    this.source = source;
    this.checkpoint = recovered ? "\u0000" : source;
    this.filename = safeFilename(filename);
    this.profile = profile;
    this.assets = assets;
    this.documentId = documentId;
    this.navigationRevision++;
    this.revision++;
    this.validRevision = -1;
    this.active = true;
    this.editing = editing;
    this.requestAfterCheck = undefined;
    diagnostics.replaceChildren();
    this.editor = new SourceEditor(
      sourcePane,
      source,
      profile,
      (value, currentAssets) => {
        this.assets = new Map(currentAssets);
        this.changed(value);
      },
      assets,
    );
    this.documentRoute(true);
    this.scheduleRecovery();
    this.check();
    this.render();
  }

  changed(source: string): void {
    this.source = source;
    this.revision++;
    this.pending = true;
    this.preview?.setEnabled(false);
    this.message("Checking…");
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.check(), 200);
    this.scheduleRecovery();
    this.render();
  }

  check(): void {
    if (!this.active) return;
    clearTimeout(this.debounce);
    this.pending = true;
    this.preview?.setEnabled(false);
    this.message("Checking…");
    this.compiler.compile(this.source, this.profile, this.revision);
    this.render();
  }

  compiled(result: Compilation): void {
    if (result.revision !== this.revision) return;
    this.pending = false;
    this.diagnosticList = result.diagnostics;
    this.editor?.view.dispatch({
      effects: tokenEffect.of(
        (result.highlights ?? []).map((range) => ({
          from: editorOffset(this.source, range.from),
          to: editorOffset(this.source, range.to),
        })),
      ),
    });
    if (result.program) {
      const candidate = reconcile(result.program, this.session);
      if (candidate.result.ok) {
        this.session?.destroy();
        this.session = candidate.result.value;
        this.validRevision = this.revision;
        if (this.preview) {
          this.preview.update(
            result.program,
            this.assets,
            this.session.getRevision().state,
            this.revision,
          );
        } else
          this.preview = new PreviewHost(
            previewContent,
            result.program,
            this.assets,
            this.session.getRevision().state,
            this.revision,
            (state) => {
              const applied = this.session?.setControls(state);
              if (applied && !applied.ok)
                this.error(new Error("E_PROTOCOL: Invalid preview answers."));
            },
            (message) => this.message(message),
          );
        this.message(
          candidate.reset.length
            ? `${candidate.reset.length} answers reset after source changes`
            : "",
        );
        if (candidate.reset.length) {
          const note = node("details");
          note.append(
            node("summary", "Reset answers"),
            node("p", candidate.reset.join(", ")),
          );
          status.append(note);
        }
      } else this.diagnosticList = candidate.result.diagnostics;
    }
    diagnostics.replaceChildren();
    for (const item of this.diagnosticList)
      action(
        diagnostics,
        `${item.code}: ${item.message} (${item.span.start.line}:${item.span.start.column})`,
        () => {
          this.editing = true;
          this.documentRoute();
          this.tab = "source";
          this.render();
          this.editor?.select(item.span.start.offset, item.span.end.offset);
        },
      );
    if (!this.valid)
      this.message(
        this.session
          ? "Preview is from the last valid source. Fix the errors to update it."
          : "Source is invalid. Fix the errors to create a preview.",
      );
    this.render();
    const after = this.requestAfterCheck;
    this.requestAfterCheck = undefined;
    if (this.valid) after?.();
  }

  unsaved(next: () => void, cancelled?: () => void): void {
    if (!this.dirty) return next();
    dialog(
      "Unsaved source changes",
      (body, close) => {
        body.append(
          node(
            "p",
            "You have unsaved changes. Save your source before leaving, or discard the changes to continue.",
          ),
        );
        action(
          body,
          "Save",
          () =>
            void this.saveSource().then((saved) => {
              if (saved) {
                close();
                next();
              }
            }),
        );
        action(body, "Discard", () => {
          close();
          next();
        });
      },
      cancelled,
    );
  }

  rename(): void {
    if (!this.active) return;
    const original = filenameParts(this.filename);
    dialog("Rename document", (body, close) => {
      const name = field(body, "Document name", original.name);
      name.maxLength = 255 - original.extension.length;
      body.append(
        node(
          "p",
          `File extension: ${original.extension || "none"}. This name will be used when you save.`,
        ),
      );
      const rename = action(body, "Rename", () => {
        if (!name.value.trim()) return;
        this.filename = safeFilename(name.value.trim() + original.extension);
        this.scheduleRecovery();
        close();
        this.render();
      });
      name.oninput = () => {
        rename.disabled = !name.value.trim();
      };
    });
  }

  saveAs(): void {
    if (!this.active) return;
    dialog("Save source as", (body, close) => {
      const filename = field(
        body,
        "Filename",
        this.filename.replace(/\.zip$/i, ""),
      );
      if (this.assets.size)
        body.append(
          node(
            "p",
            "Sidecar images are not included. Save bundle for a portable document.",
          ),
        );
      action(body, "Save", () => {
        void this.saveSource(true, filename.value).then((saved) => {
          if (saved) close();
        });
      });
    });
  }

  async saveSource(as = false, filename = this.filename): Promise<boolean> {
    if (!this.active) return false;
    const source = this.source;
    try {
      const message = await saveFile(
        sourceBytes(source),
        filename.replace(/\.zip$/i, ""),
        "text/plain",
        as,
      );
      this.checkpoint = source;
      if (as) this.filename = safeFilename(filename);
      this.scheduleRecovery();
      this.message(
        message +
          (this.assets.size
            ? " Sidecar images are not included. Save bundle for a portable document."
            : ""),
      );
      this.render();
      return true;
    } catch (error) {
      this.error(error);
      return false;
    }
  }

  pickOpen(): void {
    this.unsaved(() => {
      const input = node("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () =>
        this.chooseFiles(Array.from(input.files ?? []), true);
      input.click();
    });
  }

  chooseFiles(files: File[], checked = false): void {
    if (!files.length) return;
    if (!checked) return this.unsaved(() => this.chooseFiles(files, true));
    if (files.length > 1)
      return dialog("Choose one document", (body, close) => {
        for (const file of files)
          action(body, file.name, () => {
            close();
            this.chooseFiles([file], true);
          });
      });

    const file = files[0]!;
    const profile = profileFor(file.name);
    if (!profile)
      return dialog("Choose source profile", (body, close) => {
        for (const selected of ["markdown", "tinta"] as const)
          action(body, selected === "markdown" ? "Markdown" : "tinta", () => {
            close();
            void this.loadFile(file, selected);
          });
      });
    void this.loadFile(file, profile);
  }

  async loadFile(file: File, profile: SourceProfile): Promise<void> {
    const revision = this.revision;
    await this.attempt(async () => {
      if (/\.tinta\.zip$/i.test(file.name)) {
        const bundle = unwrap(
          await openBundle(await readFile(file, limits.bundleBytes)),
        );
        const text = bundle.source.text ?? decodeUtf8(bundle.source.bytes!);
        if (revision !== this.revision)
          throw new Error("Source changed while opening. Open cancelled.");
        this.open(
          text,
          file.name,
          bundle.source.profile,
          new Map(bundle.assets),
        );
      } else {
        const text = decodeUtf8(await readFile(file));
        if (revision !== this.revision)
          throw new Error("Source changed while opening. Open cancelled.");
        this.open(text, file.name, profile);
      }
    });
  }

  examples(): void {
    writeRoute({ section: "examples" });
    catalogDialog(
      "examples",
      examples,
      (name, source) => {
        this.unsaved(() => this.open(source, name + ".tinta", "tinta"));
      },
      () => {
        if (["examples", "snippets"].includes(readRoute()?.section ?? ""))
          this.documentRoute(true);
      },
    );
  }

  enrich(): void {
    try {
      const enriched = unwrap(
        enrichMarkdown({
          text: this.source,
          profile: "markdown",
          uri: "tinta:/document.md",
        }),
      );
      const revision = this.revision;
      dialog("Enrich as tinta", (body, close) => {
        body.append(
          node(
            "p",
            `${enriched.edits.length} proposed escapes. The original Markdown file stays unchanged.`,
          ),
          node("pre", enriched.source),
        );
        action(body, "Create tinta source", () => {
          if (revision !== this.revision)
            return this.message("Source changed. Start enrichment again.");
          this.filename = stem(this.filename) + ".tinta";
          this.checkpoint = "\u0000";
          this.profile = "tinta";
          this.editor?.setProfile("tinta");
          this.editor?.applyEdits(enriched.edits);
          if (!enriched.edits.length) this.changed(this.source);
          close();
        });
      });
    } catch (error) {
      this.error(error);
    }
  }

  snippetDialog(): void {
    writeRoute({ section: "snippets" });
    catalogDialog(
      "snippets",
      snippets,
      (_name, source) => {
        this.setEditing(true);
        this.tab = "source";
        this.render();
        this.editor?.insert(source);
      },
      () => {
        if (["examples", "snippets"].includes(readRoute()?.section ?? ""))
          this.documentRoute(true);
      },
    );
  }

  async bundle(): Promise<void> {
    if (!this.valid || !this.session) return;
    const revision = this.revision;
    await this.attempt(async () => {
      const artifact = unwrap(
        await packSource(this.session!.program, this.assets),
      );
      if (revision !== this.revision)
        throw new Error("Source changed during export. Export cancelled.");
      this.message(
        await saveFile(
          artifact.bytes,
          stem(this.filename) + ".tinta.zip",
          artifact.mediaType,
        ),
      );
    });
  }

  exportDialog(): void {
    if (!this.active) return;
    this.requestAfterCheck = () => this.showExport();
    this.check();
  }

  showExport(): void {
    dialog("Export document", (body, close) => {
      const format = select(body, "Format", [
        "Interactive HTML",
        "Static HTML",
        "Answers snapshot",
      ]);
      const answers = select(body, "Answers", [
        "Initial answers",
        "Current answers",
      ]);
      body.append(
        node(
          "p",
          "This interactive file contains the complete source, all embedded " +
            "data, hidden explanations and image metadata. Hidden content is not " +
            "private. It does not send data anywhere.",
        ),
      );
      body.append(
        node(
          "p",
          "Current answers is not an exact screen snapshot. Legends start " +
            "visible, pins are cleared and details start closed. Static HTML " +
            "contains only the resolved visible presentation, complete visible " +
            "tables and referenced images. Images may retain metadata.",
        ),
      );
      action(
        body,
        "Export file",
        () =>
          void this.attempt(async () => {
            if (!this.valid || !this.session)
              throw new Error(
                "Source is checking or invalid. Export is unavailable.",
              );

            const revision = this.revision;
            let bytes: Uint8Array, name: string, type: string;
            if (format.value === "Answers snapshot") {
              bytes = sourceBytes(
                JSON.stringify(createStateSnapshot(this.session), null, 2) +
                  "\n",
              );
              name = stem(this.filename) + ".tinta.state.json";
              type = "application/json";
            } else {
              const kind =
                format.value === "Static HTML" ? "static" : "interactive";
              const artifact = unwrap(
                await exportHtml(this.session, this.assets, {
                  format: kind,
                  answers:
                    answers.value === "Current answers" ? "current" : "initial",
                }),
              );
              bytes = artifact.bytes;
              name = stem(this.filename) + "." + kind + ".html";
              type = artifact.mediaType;
            }
            if (revision !== this.revision)
              throw new Error(
                "Source changed during export. Export cancelled.",
              );
            this.message(await saveFile(bytes, name, type));
            close();
          }),
      );
    });
  }

  importDialog(): void {
    dialog("Import local content", (body, close) => {
      body.classList.add("choice-dialog");
      body.append(
        node("p", "Bring data and images into this document from your device."),
      );
      for (const kind of [
        "CSV data",
        "JSON data",
        "Local image",
        "Add missing image files",
      ])
        action(body, kind, () => {
          close();
          const input = node("input");
          input.type = "file";
          input.onchange = () => {
            const file = input.files?.[0];
            if (file) void this.importFile(file, kind);
          };
          input.click();
        });
    });
  }

  async importFile(file: File, kind: string): Promise<void> {
    const revision = this.revision;
    await this.attempt(async () => {
      const bytes = await readFile(
        file,
        kind.includes("data") ? 5242880 : limits.assetBytes,
      );
      if (kind.includes("data")) {
        if (this.profile !== "tinta")
          throw new Error("Enrich as tinta before importing data.");

        const importer = kind === "CSV data" ? importCsv : importJson;
        dialog("Preview data import", (body, close) => {
          if (!this.valid || !this.session || !this.editor) {
            body.append(
              node(
                "p",
                "Check and fix the current source before importing data.",
              ),
            );
            return;
          }

          const used = new Set(
            this.session.program.declarations.map((item) => item.name),
          );
          const baseName =
            stem(file.name)
              .replace(/[^A-Za-z0-9_]/g, "_")
              .replace(/^[0-9]/, "data_$&") || "imported_data";
          let defaultName = baseName;

          for (let suffix = 2; used.has(defaultName); suffix++)
            defaultName = baseName + "_" + suffix;

          const position = insertionBoundary(
            this.session.program,
            sourceOffset(this.source, this.editor.view.state.selection.main.to),
          );
          body.append(
            node(
              "p",
              `Insert after source offset ${position}, at a root block boundary.`,
            ),
          );
          const name = field(body, "Table name", defaultName);
          const preview = node("pre");
          const mapping = node("div");
          body.append(mapping, preview);
          let candidate: DataImport | undefined;
          let columns: ImportColumn[] | undefined;
          const update = () => {
            const result = importer(bytes, {
              name: name.value,
              ...(columns ? { columns } : {}),
            });
            candidate =
              result.ok && !used.has(name.value) ? result.value : undefined;
            preview.textContent = used.has(name.value)
              ? "Table name already exists."
              : result.ok
                ? result.value.source
                : result.diagnostics
                    .map((d) => d.code + ": " + d.message)
                    .join("\n");
            if (result.ok && !columns) {
              columns = [...result.value.columns];
              columns.forEach((column, index) => {
                const input = field(
                  mapping,
                  column.input + " → name",
                  column.name,
                );
                const type = select(mapping, column.input + " type", [
                  column.type,
                  ...["text", "number", "boolean"].filter(
                    (t) => t !== column.type,
                  ),
                ]);
                const revise = () => {
                  columns![index] = {
                    input: column.input,
                    name: input.value,
                    type: type.value as ImportColumn["type"],
                  };
                  update();
                };
                input.oninput = revise;
                type.onchange = revise;
              });
            }
          };
          name.oninput = update;
          update();
          action(body, "Insert data", () => {
            if (!candidate) return;
            if (revision !== this.revision)
              return this.message("Source changed. Start the import again.");
            this.editor?.select(position, position);
            this.editor?.insert("\n\n" + candidate.source + "\n");
            close();
          });
        });
      } else {
        const asset = unwrap(createAsset(bytes));
        dialog(
          kind === "Local image"
            ? "Insert local image"
            : "Resolve missing image",
          (body, close) => {
            body.append(node("p", file.name));
            const alt = field(body, "Alt text");
            const decorative = field(body, "Decorative image");
            decorative.type = "checkbox";
            const path =
              kind === "Add missing image files"
                ? field(body, "Exact source image path", file.name)
                : undefined;
            const preview = node("pre");
            body.append(preview);
            const source = () =>
              `![${alt.value.replace(/[\\[\]]/g, "\\$&")}](${asset.path})`;
            alt.oninput = () => {
              preview.textContent = source();
            };
            preview.textContent = source();
            action(body, path ? "Resolve image" : "Insert image", () => {
              try {
                if (revision !== this.revision)
                  throw new Error("Source changed. Start the import again.");
                if (!path && !alt.value.trim() && !decorative.checked)
                  throw new Error(
                    "Enter meaningful alt text or mark the image decorative.",
                  );

                const key = path ? normalizeAssetPath(path.value) : asset.path;
                if (
                  path &&
                  this.session &&
                  !imageDestinations(this.session.program.flow).some(
                    (destination) => {
                      try {
                        return normalizeAssetPath(destination) === key;
                      } catch {
                        return false;
                      }
                    },
                  )
                )
                  throw new Error(
                    "Choose an exact image destination from the source.",
                  );

                const candidate = new Map(this.assets);
                candidate.set(key, asset);
                validateAssets(candidate);
                if (!path) this.editor?.insert(source(), candidate);
                else this.editor?.setAssets(candidate);
                close();
              } catch (error) {
                this.error(error);
              }
            });
          },
        );
      }
    });
  }

  preferences(): void {
    writeRoute({ section: "recovery" });
    dialog("Local recovery copies", (body, close) => {
      body.addEventListener(
        "dispose",
        () => {
          if (readRoute()?.section === "recovery") this.documentRoute(true);
        },
        { once: true },
      );
      body.append(
        node(
          "p",
          "Recovery copies are stored on this device, not saved files. At most " +
            "10 copies and 30 MiB are kept. Least recently edited copies are " +
            "evicted first; the active copy is never silently discarded. Reader " +
            "answers are never stored.",
        ),
      );
      const enable = field(body, "Keep local recovery copies on this device");
      enable.type = "checkbox";
      enable.checked = this.drafts.enabled;
      enable.onchange = () => {
        this.drafts.setEnabled(enable.checked);
        this.drafts.cancel();
        if (enable.checked) this.scheduleRecovery();
        else
          action(body, "Delete existing recovery copies", () =>
            this.deleteRecoveries(),
          );
      };
      action(
        body,
        "Show recovery copies",
        () =>
          void this.attempt(async () => {
            const copies = await this.recovery.list();
            const list = node("div");
            body.insertBefore(
              list,
              body.querySelector(":scope > .dialog-actions"),
            );
            if (!copies.length)
              list.append(node("p", "No local recovery copies."));
            for (const copy of copies) {
              const entry = node("div");
              list.append(entry);
              action(entry, "Recover " + copy.filename, () => {
                close();
                this.unsaved(() =>
                  this.open(
                    copy.source,
                    copy.filename,
                    copy.profile,
                    new Map(copy.assets),
                    copy.changed !== false,
                    copy.id,
                  ),
                );
              });
              action(
                entry,
                "Delete this recovery",
                () =>
                  void this.attempt(async () => {
                    if (copy.id === this.documentId) this.drafts.cancel();
                    await this.recovery.delete(copy.id);
                    entry.remove();
                  }),
              );
            }
          }),
      );
      action(body, "Delete all local recovery copies", () =>
        this.deleteRecoveries(),
      );
    });
  }

  deleteRecoveries(): void {
    dialog("Delete all local recovery copies?", (body, close) => {
      action(
        body,
        "Delete all",
        () =>
          void this.attempt(async () => {
            this.drafts.cancel();
            await this.recovery.delete();
            this.message("Local recovery copies deleted.");
            close();
          }),
      );
    });
  }

  scheduleRecovery(): void {
    if (!this.active) return;
    this.drafts.schedule({
      id: this.documentId,
      source: this.source,
      profile: this.profile,
      filename: this.filename,
      edited: Date.now(),
      changed: this.dirty,
      assets: [...this.assets],
    });
  }
}
