import type {
  AnalysisSnapshot,
  SourceIdentity,
  SourceAcquisition,
} from "../../contracts/editor-analysis.js";
import type {
  ExtensionToWebview,
  WebviewToExtension,
} from "../../contracts/vscode-webview.js";

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type HostCommands = Assert<
  Equal<
    ExtensionToWebview["kind"],
    "load" | "set-enabled" | "reset" | "get-state" | "destroy"
  >
>;

export type BrowserCommands = Assert<
  Equal<
    WebviewToExtension["kind"],
    "ready" | "destroyed" | "state" | "diagnostics"
  >
>;

export type SeparateProtocol = Assert<
  Equal<ExtensionToWebview["protocol"], "tinta-vscode-1">
>;

export type RevisionBinding = Assert<
  Equal<AnalysisSnapshot["identity"], SourceIdentity>
>;

export type UnverifiedSourceHasNoSnapshot = Assert<
  Equal<
    Extract<
      SourceAcquisition,
      { kind: "unverified" | "invalid-encoding" | "conversion-required" }
    > extends { snapshot: unknown }
      ? true
      : false,
    false
  >
>;

export type PortableAnalysisDto = Assert<
  Equal<
    AnalysisSnapshot,
    import("../../packages/types/src/editor.js").AnalysisSnapshot
  >
>;
