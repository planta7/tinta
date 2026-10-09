import { createRoot } from "react-dom/client";
import { studioVersion, studioBuild } from "./studio-runtime.js";
import { node } from "./dialogs.js";

export function createWorkspace() {
  const toolbar = document.createElement("div");
  toolbar.className = "studio-chrome";
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
  const previewContent = document.createElement("div");
  previewContent.className = "preview-content";
  const sourceHeading = node("div", "Source");
  sourceHeading.className = "pane-heading";
  sourceHeading.append(node("span", "tinta"));
  const previewHeading = node("div", "Live preview");
  previewHeading.className = "pane-heading";
  previewHeading.append(node("span", "Try your document as you write"));
  const emptyPreview = node("div");
  emptyPreview.className = "empty-preview";
  emptyPreview.append(
    node("span", "A document to explore."),
    node("h2", "Your next idea starts here."),
    node("p", "Start writing, or open an example to discover tinta."),
  );
  sourcePane.append(sourceHeading);
  previewPane.append(previewHeading, emptyPreview, previewContent);
  panes.append(sourcePane, previewPane);
  surface.append(tabs, panes);
  const statusbar = node("footer");
  statusbar.className = "statusbar";
  const localNote = node("span", "");
  localNote.className = "local-note";
  const version = node("span", `v${studioVersion} · ${studioBuild}`);
  version.className = "studio-version";
  statusbar.append(version, status, localNote);
  document.body.append(toolbar, diagnostics, surface, statusbar);
  const root = createRoot(toolbar);
  return {
    toolbar,
    root,
    status,
    diagnostics,
    surface,
    tabs,
    sourcePane,
    previewPane,
    previewContent,
    sourceHeading,
    emptyPreview,
    localNote,
  };
}
