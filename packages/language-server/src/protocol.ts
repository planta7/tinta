import type { AuthoringQuery, AuthoringResult } from "./authoring.js";
import type { Diagnostic, Result } from "@tinta/types";
import type { AnalysisSnapshot } from "@tinta/types/editor";

export interface AnalysisRequest {
  readonly uri: string;
  readonly instance: string;
  readonly version: number;
  readonly text: string;
  readonly query?: {
    readonly id: number;
    readonly params: AuthoringQuery;
  };
}

export interface AnalysisReply {
  readonly request: Omit<AnalysisRequest, "text">;
  readonly result: Result<AnalysisSnapshot>;
  readonly authoring?: AuthoringResult;
}

export interface ReleaseRequest {
  readonly release: {
    readonly uri: string;
    readonly instance: string;
  };
}

export interface AnalysisWorker {
  postMessage(request: AnalysisRequest | ReleaseRequest): void;
  on(event: "message", listener: (reply: AnalysisReply) => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  terminate(): Promise<number>;
}

export interface Presentation {
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot?: AnalysisSnapshot;
}
