/** Separate outer transport; never an extension of tinta-host-1. */
import type {
  Asset,
  ControlState,
  Diagnostic,
  ProgramIR,
} from "./public-api.js";
import type { SourceIdentity } from "./editor-analysis.js";

export interface WebviewIdentity {
  readonly protocol: "tinta-vscode-1";
  readonly panelId: string;
  readonly capability: string;
  readonly requestId: number;
  readonly source: SourceIdentity;
}

/** Canonical padded base64 keeps the outer protocol JSON-only. */
export interface WebviewAsset {
  readonly path: string;
  readonly mime: Asset["mime"];
  readonly sha256: Asset["sha256"];
  readonly bytesBase64: string;
}

export type ExtensionToWebview = WebviewIdentity &
  (
    | Readonly<{
        kind: "load";
        program: ProgramIR;
        assets: readonly WebviewAsset[];
        assetPaths: Readonly<Record<string, string>>;
        baseline: ControlState;
        assetRevision: number;
      }>
    | Readonly<{ kind: "set-enabled"; enabled: boolean }>
    | Readonly<{ kind: "reset" | "get-state" | "destroy" }>
  );

export type WebviewToExtension = WebviewIdentity &
  (
    | Readonly<{ kind: "ready" | "destroyed" }>
    | Readonly<{
        kind: "state";
        controls: ControlState;
        sessionRevision: number;
        assetRevision: number;
      }>
    | Readonly<{
        kind: "diagnostics";
        diagnostics: readonly Diagnostic[];
      }>
  );

/** No path-read requests, command IDs, URL fetching, saves or executable content. */
