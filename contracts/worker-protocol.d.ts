/** Versioned host/worker/preview messages. All messages are untrusted until schema-validated. */
import type {
  SourceProfile,
  Diagnostic,
  ProgramIR,
  ControlState,
  Revision,
  Asset,
  Result,
} from "./public-api.js";

export interface MessageBase {
  readonly protocol: "tinta-host-1";
  readonly documentId: string;
  readonly capability: string;
  readonly requestId: number;
  readonly sourceRevision: number;
}

export type WorkerRequest = MessageBase &
  (
    | Readonly<{
        kind: "compile";
        source: string;
        uri: string;
        profile: SourceProfile;
      }>
    | Readonly<{
        kind: "cancel";
        targetRequestId: number;
      }>
  );

/** Optional parser-derived source decorations. Original UTF-16 offsets satisfy
 * 0 <= from < to <= source.length; at most the registry astNodes limit.
 * These ranges grant presentation only, never executable source capability.
 */
export interface SourceHighlight {
  readonly from: number;
  readonly to: number;
}

export type WorkerResponse = MessageBase &
  (
    | Readonly<{
        kind: "compiled";
        program: ProgramIR;
        diagnostics: readonly Diagnostic[];
        highlights?: readonly SourceHighlight[];
      }>
    | Readonly<{
        kind: "rejected";
        diagnostics: readonly Diagnostic[];
        highlights?: readonly SourceHighlight[];
      }>
    | Readonly<{
        kind: "cancelled";
        targetRequestId: number;
      }>
  );

/** Optional load assetPaths maps normalized relative source paths to supplied canonical
 * Asset.path values. Targets must exist in assets; aliases cannot redefine canonical
 * entries. Validate every lookup path and retain the AssetStore limit of 100000 entries.
 * Omission preserves canonical-only lookup. This grants no filesystem or network access.
 */
export type PreviewRequest = MessageBase &
  (
    | Readonly<{
        kind: "load";
        program: ProgramIR;
        assets: readonly Asset[];
        assetPaths?: Readonly<Record<string, string>>;
        baseline?: ControlState;
      }>
    | Readonly<{
        kind: "set-controls";
        controls: ControlState;
      }>
    | Readonly<{ kind: "reset" }>
    | Readonly<{
        kind: "set-enabled";
        enabled: boolean;
      }>
    | Readonly<{ kind: "get-state" }>
    | Readonly<{ kind: "destroy" }>
  );

export type PreviewResponse = MessageBase &
  (
    | Readonly<{ kind: "ready" }>
    | Readonly<{
        kind: "state";
        controls: ControlState;
        sessionRevision: number;
      }>
    | Readonly<{
        kind: "action-result";
        result: Result<Revision>;
      }>
    | Readonly<{
        kind: "diagnostics";
        diagnostics: readonly Diagnostic[];
      }>
    | Readonly<{ kind: "destroyed" }>
  );

/** No path-read, fetch, eval, HTML injection, storage, clipboard or save command exists. */
