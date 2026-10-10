/** Portable editor contracts for 1.0-draft.3; no filesystem or editor SDK types. */
import type {
  Diagnostic,
  HexSha256,
  ScalarType,
  SourceProfile,
  Span,
} from "./public-api.js";

export interface SourceIdentity {
  readonly uri: string;
  readonly documentInstance: string;
  readonly editorVersion: number;
  readonly sourceRevision: number;
  readonly profile: SourceProfile;
  readonly sourceSha256: HexSha256;
}

/** UTF-16 boundaries. End excludes the line ending; next includes it. */
export interface SourceLineMap {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sourceNext: number;
  readonly editorStart: number;
  readonly editorEnd: number;
  readonly editorNext: number;
}

export interface SourceSnapshot {
  readonly identity: SourceIdentity;
  /** Validated UTF-8, including a retained BOM. Copy buffers at boundaries. */
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly editorText: string;
  readonly lines: readonly SourceLineMap[];
  readonly bomUnits: 0 | 1;
  readonly fidelity: "original" | "mapped-edit" | "explicit-copy";
}

/** Unverified/replacement-decoded disk text cannot become a SourceSnapshot. */
export type SourceAcquisition =
  | Readonly<{
      kind: "verified";
      snapshot: SourceSnapshot;
    }>
  | Readonly<{
      kind: "unverified" | "invalid-encoding" | "conversion-required";
      uri: string;
      documentInstance: string;
      editorVersion: number;
      diagnostics: readonly Diagnostic[];
    }>;

export interface VersionedSourceChange {
  readonly documentInstance: string;
  readonly previousVersion: number;
  readonly nextVersion: number;
  /** Nonoverlapping changes against the previous editor buffer, descending order. */
  readonly changes: readonly {
    readonly from: number;
    readonly to: number;
    readonly text: string;
  }[];
}

export interface EditorPosition {
  readonly line: number;
  readonly character: number;
}

export type EditorType =
  | Readonly<{
      kind: "scalar";
      scalar: ScalarType;
    }>
  | Readonly<{
      kind: "list";
      scalar: ScalarType | "never";
    }>
  | Readonly<{
      kind: "table";
      columns: readonly {
        readonly name: string;
        readonly type: ScalarType;
      }[];
    }>;

export interface EditorSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind:
    | "heading"
    | "constant"
    | "calculation"
    | "control"
    | "table"
    | "view"
    | "column";
  readonly extent: Span;
  readonly selection: Span;
  /** Present only when binding/type analysis has established this fact. */
  readonly type?: EditorType;
}

export interface EditorReference {
  readonly span: Span;
  readonly target: string;
}

export interface EditorToken {
  readonly span: Span;
  readonly kind:
    | "directive"
    | "declaration"
    | "reference"
    | "column"
    | "option"
    | "literal"
    | "function";
}

export interface CompletionContext {
  readonly replacement: Span;
  readonly kind:
    | "directive"
    | "option"
    | "literal"
    | "expression"
    | "selection"
    | "column"
    | "none";
  readonly allowedNames: readonly string[];
}

export interface EditorHelp {
  readonly span: Span;
  readonly text: string;
  /** Plain text; no HTML, executable links or trusted Markdown. */
  readonly signatures: readonly string[];
}

/** Plain-text built-in call help; argument is a zero-based lexical index. */
export interface EditorSignatureHelp {
  readonly label: string;
  readonly argument: number;
  readonly example: string;
}

export interface AnalysisSnapshot {
  readonly identity: SourceIdentity;
  readonly sourceText: string;
  readonly validity: "valid" | "invalid";
  readonly completeness: "semantic" | "partial";
  readonly diagnostics: readonly Diagnostic[];
  readonly tokens: readonly EditorToken[];
  readonly symbols: readonly EditorSymbol[];
  readonly references: readonly EditorReference[];
}

/** Queries operate on an immutable, exact-version snapshot; never read files. */
export interface EditorAnalysisQueries {
  completion(
    snapshot: AnalysisSnapshot,
    sourceOffset: number,
  ): CompletionContext;
  help(
    snapshot: AnalysisSnapshot,
    sourceOffset: number,
  ): EditorHelp | undefined;
  signatureHelp(
    snapshot: AnalysisSnapshot,
    sourceOffset: number,
  ): EditorSignatureHelp | undefined;
  definition(
    snapshot: AnalysisSnapshot,
    sourceOffset: number,
  ): Span | undefined;
  references(snapshot: AnalysisSnapshot, symbolId: string): readonly Span[];
}
