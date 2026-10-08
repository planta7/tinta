/** Versioned host/worker/preview messages. All messages are untrusted until schema-validated. */
import type { SourceProfile, Diagnostic, ProgramIR, ControlState, Revision, Asset, Result } from './public-api.js';
export interface MessageBase {
  readonly protocol:'tinta-host-1'; readonly documentId:string; readonly capability:string;
  readonly requestId:number; readonly sourceRevision:number;
}
export type WorkerRequest = MessageBase & (
  | Readonly<{kind:'compile'; source:string; uri:string; profile:SourceProfile}>
  | Readonly<{kind:'cancel'; targetRequestId:number}>
);
export type WorkerResponse = MessageBase & (
  | Readonly<{kind:'compiled'; program:ProgramIR; diagnostics:readonly Diagnostic[]}>
  | Readonly<{kind:'rejected'; diagnostics:readonly Diagnostic[]}>
  | Readonly<{kind:'cancelled'; targetRequestId:number}>
);
export type PreviewRequest = MessageBase & (
  | Readonly<{kind:'load'; program:ProgramIR; assets:readonly Asset[]; baseline?:ControlState}>
  | Readonly<{kind:'set-controls'; controls:ControlState}>
  | Readonly<{kind:'reset'}>
  | Readonly<{kind:'set-enabled'; enabled:boolean}>
  | Readonly<{kind:'get-state'}>
  | Readonly<{kind:'destroy'}>
);
export type PreviewResponse = MessageBase & (
  | Readonly<{kind:'ready'}>
  | Readonly<{kind:'state'; controls:ControlState; sessionRevision:number}>
  | Readonly<{kind:'action-result'; result:Result<Revision>}>
  | Readonly<{kind:'diagnostics'; diagnostics:readonly Diagnostic[]}>
  | Readonly<{kind:'destroyed'}>
);
/** No path-read, fetch, eval, HTML injection, storage, clipboard or save command exists. */
