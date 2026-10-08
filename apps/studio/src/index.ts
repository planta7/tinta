import { editorOffset, sourceOffset } from "./source-buffer.js";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
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
  insertionBoundary,
  profileFor,
  reconcile,
  safeFilename,
  stem,
} from "./model.js";
import { RecoveryStore, type Recovery } from "./recovery.js";
import { readFile, saveFile, sourceBytes } from "./files.js";
import { token } from "./protocol.js";
import { examples, snippets, workerCode } from "./studio-runtime.js";

const toolbar = document.createElement("div");
const status = document.createElement("div");
status.className = "status";
status.setAttribute("role", "status");
const diagnostics = document.createElement("div");
diagnostics.className = "diagnostics";
const surface = document.createElement("main");
const tabs = document.createElement("div");
tabs.className = "tabs";
const panes = document.createElement("div");
panes.className = "panes";
const sourcePane = document.createElement("section");
sourcePane.className = "source-pane";
sourcePane.setAttribute("aria-label", "Source");
const previewPane = document.createElement("section");
previewPane.className = "preview-pane";
previewPane.setAttribute("aria-label", "Preview");
panes.append(sourcePane, previewPane);
surface.append(tabs, panes);
document.body.append(toolbar, status, diagnostics, surface);
const root = createRoot(toolbar);

function button(label: string, action: () => void, disabled = false) {
  return h(
    "button",
    {
      key: label,
      type: "button",
      disabled,
      onClick: (event: { currentTarget: HTMLButtonElement }) => {
        event.currentTarget.focus();
        action();
      },
    },
    label,
  );
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function dialog(
  title: string,
  build: (body: HTMLDialogElement, close: () => void) => void,
): void {
  const trigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  const previous = Array.from(
    document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
  ).at(-1);
  if (previous) {
    previous.inert = true;
    previous.setAttribute("aria-hidden", "true");
  }
  const element = node("dialog");
  const heading = node("h2", title);
  heading.id = "dialog-" + token();
  element.setAttribute("aria-labelledby", heading.id);
  element.append(heading);
  const close = () => element.close();
  build(element, close);
  const cancel = node("button", "Cancel");
  cancel.autofocus = true;
  cancel.onclick = close;
  element.append(cancel);
  element.onclose = () => {
    element.remove();
    if (previous) {
      previous.inert = false;
      previous.removeAttribute("aria-hidden");
    }
    trigger?.focus();
  };
  document.body.append(element);
  element.showModal();
  cancel.focus();
}

function action(
  parent: HTMLElement,
  label: string,
  run: () => void,
): HTMLButtonElement {
  const element = node("button", label);
  element.onclick = () => {
    element.focus();
    run();
  };
  parent.append(element);
  return element;
}

function field(
  parent: HTMLElement,
  label: string,
  value = "",
): HTMLInputElement {
  const wrapper = node("label", label + " ");
  const input = node("input");
  input.value = value;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

function select(
  parent: HTMLElement,
  label: string,
  options: string[],
): HTMLSelectElement {
  const wrapper = node("label", label + " ");
  const input = node("select");
  input.setAttribute("aria-label", label);
  for (const value of options) {
    const option = node("option", value);
    option.value = value;
    input.append(option);
  }
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

class Studio {
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
  editor?: SourceEditor;
  preview: PreviewHost | undefined;
  assets = new Map<string, Asset>();
  private compiler = new CompilerHost(workerCode, (result) =>
    this.compiled(result),
  );
  private debounce?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recovery = new RecoveryStore();
  private recoveryEnabled = false;
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
        this.unsaved(() => this.open("", "untitled.tinta", "tinta"));
      }
      if (key === "e" && event.shiftKey) {
        event.preventDefault();
        this.exportDialog();
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (this.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("dragover", (event) => event.preventDefault());
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      this.chooseFiles(Array.from(event.dataTransfer?.files ?? []));
    });
    this.render();
  }

  get dirty(): boolean {
    return this.source !== this.checkpoint;
  }

  get valid(): boolean {
    return (
      !this.pending && this.validRevision === this.revision && !!this.session
    );
  }

  message(text: string): void {
    status.textContent = text;
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
    surface.className = this.editing ? "editing" : "";
    surface.dataset.tab = this.tab;
    if (!this.active) {
      root.render(
        h(
          "main",
          { className: "welcome" },
          h("h1", null, "Tinta"),
          h("p", null, "Local, interactive documents. Start with Markdown."),
          button("New document", () =>
            this.open("", "untitled.tinta", "tinta"),
          ),
          button("Open file", () => this.pickOpen()),
          button("Explore examples", () => this.examples()),
          button("Local recovery copies", () => this.preferences()),
        ),
      );
      return;
    }
    root.render(
      h(
        "header",
        null,
        h("h1", null, this.filename + (this.dirty ? " • Changed" : "")),
        h(
          "span",
          null,
          this.profile === "markdown" ? "Markdown" : "Tinta 1.0 draft",
        ),
        button(this.editing ? "Read" : "Edit", () => {
          this.editing = !this.editing;
          if (!this.editing) this.check();
          this.render();
        }),
        button("Open", () => this.pickOpen()),
        button("New", () =>
          this.unsaved(() => this.open("", "untitled.tinta", "tinta")),
        ),
        button("Save source", () => void this.saveSource()),
        button("Save source as", () => this.saveAs()),
        button("Save bundle", () => void this.bundle(), !this.valid),
        button("Export", () => this.exportDialog(), !this.valid),
        button("Reset reading", () => {
          this.session?.reset();
          this.preview?.reset();
        }),
        button("Check", () => this.check()),
        button("Import", () => this.importDialog()),
        button(
          "Snippets",
          () => this.snippetDialog(),
          this.profile !== "tinta",
        ),
        button("Examples", () => this.examples()),
        button("Recovery", () => this.preferences()),
        ...(this.profile === "markdown"
          ? [button("Enrich as Tinta", () => this.enrich())]
          : []),
      ),
    );
  }

  open(
    source: string,
    filename: string,
    profile: SourceProfile,
    assets = new Map<string, Asset>(),
    recovered = false,
  ): void {
    clearTimeout(this.debounce);
    clearTimeout(this.recoveryTimer);
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
    this.documentId = token();
    this.revision++;
    this.validRevision = -1;
    this.active = true;
    this.editing = false;
    this.requestAfterCheck = undefined;
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
    if (result.program) {
      const candidate = reconcile(result.program, this.session);
      if (candidate.result.ok) {
        this.session?.destroy();
        this.session = candidate.result.value;
        this.validRevision = this.revision;
        this.editor?.view.dispatch({
          effects: tokenEffect.of(
            result.program.declarations.map((item) => ({
              from: editorOffset(this.source, item.span.start.offset),
              to: editorOffset(this.source, item.span.end.offset),
            })),
          ),
        });
        if (this.preview) {
          this.preview.update(
            result.program,
            this.assets,
            this.session.getRevision().state,
            this.revision,
          );
        } else
          this.preview = new PreviewHost(
            previewPane,
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
            : "Source checked.",
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

  unsaved(next: () => void): void {
    if (!this.dirty) return next();
    dialog("Unsaved source changes", (body, close) => {
      body.append(node("p", "Save your source before continuing?"));
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
          action(body, selected === "markdown" ? "Markdown" : "Tinta", () => {
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
    dialog("Explore examples", (body, close) => {
      for (const [name, source] of Object.entries(examples))
        action(body, name, () => {
          close();
          this.unsaved(() => this.open(source, name + ".tinta", "tinta"));
        });
    });
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
      dialog("Enrich as Tinta", (body, close) => {
        body.append(
          node(
            "p",
            `${enriched.edits.length} proposed escapes. The original Markdown file stays unchanged.`,
          ),
          node("pre", enriched.source),
        );
        action(body, "Create Tinta source", () => {
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
    dialog("Insert Tinta snippet", (body, close) => {
      for (const [name, source] of Object.entries(snippets))
        action(body, name, () => {
          close();
          this.editing = true;
          this.render();
          this.editor?.insert(source);
        });
    });
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
          throw new Error("Enrich as Tinta before importing data.");
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
    dialog("Local recovery copies", (body, close) => {
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
      enable.checked = this.recoveryEnabled;
      enable.onchange = () => {
        this.recoveryEnabled = enable.checked;
        clearTimeout(this.recoveryTimer);
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
            body.append(list);
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
                    true,
                  ),
                );
              });
              action(
                entry,
                "Delete this recovery",
                () =>
                  void this.attempt(async () => {
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
            await this.recovery.delete();
            this.message("Local recovery copies deleted.");
            close();
          }),
      );
    });
  }

  scheduleRecovery(): void {
    clearTimeout(this.recoveryTimer);
    if (!this.recoveryEnabled || !this.active) return;
    this.recoveryTimer = setTimeout(() => {
      const copy: Recovery = {
        id: this.documentId,
        source: this.source,
        profile: this.profile,
        filename: this.filename,
        edited: Date.now(),
        assets: [...this.assets],
      };
      void this.recovery
        .save(copy)
        .catch(() =>
          this.message(
            "W_RECOVERY_UNAVAILABLE: Recovery storage is unavailable or full. " +
              "Your source remains in memory; save source is available.",
          ),
        );
    }, 1000);
  }
}
new Studio();
