import { createElement as h } from "react";
import { brand, button, menu } from "./controls.js";
import type { SourceProfile } from "@tinta/types";

export interface WorkspaceActions {
  filename: string;
  dirty: boolean;
  profile: SourceProfile;
  valid: boolean;
  editing: boolean;
  home: () => void;
  newDocument: () => void;
  saveSource: () => void;
  exportDialog: () => void;
  pickOpen: () => void;
  saveAs: () => void;
  bundle: () => void;
  importDialog: () => void;
  snippetDialog: () => void;
  check: () => void;
  resetReading: () => void;
  examples: () => void;
  preferences: () => void;
  enrich: () => void;
  setEditing: (editing: boolean) => void;
}

export function WorkspaceHeader(studio: WorkspaceActions) {
  return h(
    "header",
    { className: "workspace-header" },
    h(
      "div",
      { className: "document-bar" },
      brand(),
      h(
        "div",
        { className: "document-identity" },
        h("h1", { title: studio.filename }, studio.filename),
        h(
          "span",
          { className: "document-checkpoint" },
          studio.dirty ? "Changed" : "Source unchanged",
        ),
      ),
      h(
        "span",
        { className: "profile-badge" },
        studio.profile === "markdown" ? "Markdown" : "Tinta 1.0 draft",
      ),
      h(
        "div",
        { className: "primary-actions" },
        button("Save source", () => void studio.saveSource(), false, {
          icon: "save",
        }),
        button("Export", () => studio.exportDialog(), !studio.valid, {
          icon: "export",
          className: "primary",
        }),
      ),
    ),
    h(
      "div",
      { className: "workspace-tools" },
      h(
        "nav",
        { className: "document-menus", "aria-label": "Document actions" },
        menu("File", [
          button("Home", () => studio.home()),
          button("New", studio.newDocument, false, { icon: "new" }),
          button("Open", () => studio.pickOpen(), false, { icon: "open" }),
          h("hr", { key: "separator" }),
          button("Save source as", () => studio.saveAs()),
          button("Save bundle", () => void studio.bundle(), !studio.valid),
        ]),
        menu("Insert", [
          button("Import", () => studio.importDialog()),
          button(
            "Snippets",
            () => studio.snippetDialog(),
            studio.profile !== "tinta",
          ),
        ]),
        menu("Tools", [
          button("Check", () => studio.check()),
          button("Reset reading", studio.resetReading),
          h("hr", { key: "separator" }),
          button("Examples", () => studio.examples()),
          button("Recovery", () => studio.preferences()),
        ]),
      ),
      studio.profile === "markdown"
        ? button("Enrich as Tinta", () => studio.enrich(), false, {
            className: "text-button enrich-action",
          })
        : null,
      h(
        "div",
        { className: "mode-switch", "aria-label": "Document mode" },
        button("Read", () => studio.setEditing(false), false, {
          icon: "read",
          pressed: !studio.editing,
        }),
        button("Edit", () => studio.setEditing(true), false, {
          icon: "edit",
          pressed: studio.editing,
        }),
      ),
    ),
  );
}
