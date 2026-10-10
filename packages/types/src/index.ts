/** Shared integration types; runtime capabilities are exported by their owning packages. */
export type SourceProfile = "markdown" | "tinta";
export type Scalar = string | number | boolean;
export type ScalarType = "text" | "number" | "boolean";
export type Value = Scalar | readonly Scalar[];
export type HexSha256 = string; // exactly 64 lowercase hexadecimal characters
export type NodeId = string; // n + six decimal preorder digits; stable within one program

export type SourceInput = Readonly<
  {
    uri: string;
    profile: SourceProfile;
  } & (
    | {
        text: string;
        bytes?: never;
      }
    | {
        bytes: Uint8Array;
        text?: never;
      }
  )
>;

export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface Span {
  readonly uri: string;
  readonly start: Position;
  readonly end: Position;
}

export type Phase =
  | "decode"
  | "parse"
  | "bind"
  | "type"
  | "evaluate"
  | "assets"
  | "export"
  | "host";

export interface Diagnostic {
  readonly code: string; // must occur in spec/registry.json
  readonly severity: "error" | "warning";
  readonly phase: Phase;
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly {
    readonly message: string;
    readonly span: Span;
  }[];
  readonly details?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
}

export type Result<T> =
  | Readonly<{
      ok: true;
      value: T;
      diagnostics: readonly Diagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly Diagnostic[];
    }>;

export interface Metadata {
  readonly version: "1.0";
  readonly title: string;
  readonly locale:
    | "en-US"
    | "en-GB"
    | "es-ES"
    | "fr-FR"
    | "de-DE"
    | "ja-JP"
    | "zh-CN"
    | "zh-TW";
  readonly currency:
    "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "CNY";
}

export type Builtin =
  | "if"
  | "min"
  | "max"
  | "round"
  | "pow"
  | "count"
  | "sum"
  | "mean"
  | "fixed"
  | "percent"
  | "money";

export type UnaryOperator = "+" | "-" | "not";

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

export interface Located {
  readonly span: Span;
}

export type Expr =
  | (Located &
      Readonly<{
        kind: "literal";
        value: Scalar;
        raw: string;
      }>)
  | (Located &
      Readonly<{
        kind: "list";
        items: readonly Expr[];
      }>)
  | (Located &
      Readonly<{
        kind: "name";
        name: string;
      }>)
  | (Located &
      Readonly<{
        kind: "row-field";
        field: string;
      }>)
  | (Located &
      Readonly<{
        kind: "unary";
        operator: UnaryOperator;
        operand: Expr;
      }>)
  | (Located &
      Readonly<{
        kind: "binary";
        operator: BinaryOperator;
        left: Expr;
        right: Expr;
      }>)
  | (Located &
      Readonly<{
        kind: "call";
        name: Builtin;
        arguments: readonly Expr[];
      }>);

export interface Column {
  readonly name: string;
  readonly type: ScalarType;
}

export interface Row {
  readonly id: string;
  readonly cells: readonly Scalar[];
}

export interface TableValue {
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
}

export interface BaseDeclaration extends Located {
  readonly id: NodeId;
  readonly name: string;
}

export interface SliderDefinition extends BaseDeclaration {
  readonly kind: "slider";
  readonly initial: number;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly grid: {
    readonly scale: number;
    readonly minUnits: string;
    readonly stepUnits: string;
    readonly ticks: number;
  };
}

export interface ToggleDefinition extends BaseDeclaration {
  readonly kind: "toggle";
  readonly initial: boolean;
  readonly label: string;
}

export interface ChoiceDefinition extends BaseDeclaration {
  readonly kind: "choice";
  readonly initial: string;
  readonly label: string;
  readonly options: readonly string[];
}

export type ControlDefinition =
  SliderDefinition | ToggleDefinition | ChoiceDefinition;

export type Declaration =
  | ControlDefinition
  | (BaseDeclaration &
      Readonly<{
        kind: "let" | "calc";
        expression: Expr;
      }>)
  | (BaseDeclaration &
      Readonly<{
        kind: "data";
        table: TableValue;
      }>)
  | (BaseDeclaration &
      Readonly<{
        kind: "view";
        source: string;
        where?: Expr;
        sort?: string;
        descending: boolean;
      }>);

export type ChartType =
  "line" | "area" | "bar" | "scatter" | "pie" | "donut" | "histogram";

export type SeriesSource =
  | Readonly<{
      kind: "columns";
      columns: readonly string[];
    }>
  | Readonly<{
      kind: "expression";
      expression: Expr;
    }>;

export interface ChartSpec extends Located {
  readonly id: NodeId;
  readonly kind: ChartType;
  readonly source: string;
  readonly x: string;
  readonly y?: SeriesSource;
  readonly title: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly select?: string;
  readonly bins?: number;
}

export interface BaseNode extends Located {
  readonly id: NodeId;
}

export type DocNode =
  | (BaseNode &
      Readonly<{
        kind: "text";
        value: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "interpolation";
        expression: Expr;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "paragraph" | "emphasis" | "strong" | "delete" | "blockquote";
        children: readonly DocNode[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "heading";
        level: 1 | 2 | 3 | 4 | 5 | 6;
        anchor: string;
        children: readonly DocNode[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "link";
        destination: string;
        title?: string;
        children: readonly DocNode[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "image";
        destination: string;
        alt: string;
        title?: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "code";
        block: boolean;
        language?: string;
        value: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "raw-html";
        value: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "break";
        hard: boolean;
      }>)
  | (BaseNode & Readonly<{ kind: "thematic-break" }>)
  | (BaseNode &
      Readonly<{
        kind: "list";
        ordered: boolean;
        start: number;
        tight: boolean;
        items: readonly ListItem[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "markdown-table";
        align: readonly ("left" | "right" | "center" | "none")[];
        header: readonly (readonly DocNode[])[];
        rows: readonly (readonly (readonly DocNode[])[])[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "when";
        condition: Expr;
        children: readonly DocNode[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "details";
        summary: string;
        children: readonly DocNode[];
      }>)
  | (BaseNode &
      Readonly<{
        kind: "control";
        name: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "data-table";
        source: string;
        title: string;
      }>)
  | (BaseNode &
      Readonly<{
        kind: "chart";
        chart: ChartSpec;
      }>);

export interface ListItem extends BaseNode {
  readonly checked?: boolean;
  readonly children: readonly DocNode[];
}

export interface ProgramIR {
  readonly abi: "tinta-ir-1";
  readonly sourceVersion: "1.0";
  readonly contractRevision: "1.0-draft.3";
  readonly profile: SourceProfile;
  readonly source: string;
  readonly sourceUri: string;
  readonly sourceSha256: HexSha256;
  readonly metadata: Metadata;
  readonly declarations: readonly Declaration[];
  readonly flow: readonly DocNode[];
}

declare const programBrand: unique symbol;
export type Program = ProgramIR & { readonly [programBrand]: true };

export interface CompilerOptions {
  readonly limits?: Readonly<Record<string, number>>;
}
/** Validate all IR enums, names, shapes, spans, hashes, limits, types and graph; no trust in a brand from JSON. */

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface Enrichment {
  readonly source: string;
  readonly edits: readonly TextEdit[];
  readonly originalSha256: HexSha256;
}

export type ControlState = Readonly<Record<string, Scalar>>;

export interface ChartPoint {
  readonly id: string;
  readonly rowId: string;
  readonly seriesIndex: number;
  readonly x: string | number;
  readonly y: number;
}

export interface HistogramBin {
  readonly id: string;
  readonly lower: number;
  readonly upper: number;
  readonly upperInclusive: boolean;
  readonly count: number;
}

export interface PreparedChart {
  readonly id: NodeId;
  readonly type: ChartType;
  readonly title: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly source: string;
  readonly select?: string;
  readonly series: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly points: readonly ChartPoint[];
  readonly bins: readonly HistogramBin[];
  readonly table: TableValue;
  readonly empty: boolean;
}

export type SafeHtmlTag =
  | "article"
  | "section"
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "pre"
  | "code"
  | "em"
  | "strong"
  | "del"
  | "hr"
  | "br"
  | "a"
  | "img"
  | "figure"
  | "figcaption"
  | "table"
  | "caption"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "details"
  | "summary"
  | "label"
  | "input"
  | "select"
  | "option"
  | "button"
  | "output"
  | "div"
  | "span";

export type ResolvedNode =
  | Readonly<{
      kind: "text";
      id: NodeId;
      value: string;
    }>
  | Readonly<{
      kind: "element";
      id: NodeId;
      tag: SafeHtmlTag;
      attributes: Readonly<Record<string, string | number | boolean>>;
      children: readonly ResolvedNode[];
    }>
  | Readonly<{
      kind: "control";
      id: NodeId;
      definition: ControlDefinition;
      value: Scalar;
    }>
  | Readonly<{
      kind: "chart";
      id: NodeId;
      chart: PreparedChart;
    }>
  | Readonly<{
      kind: "image";
      id: NodeId;
      destination: string;
      alt: string;
      title?: string;
    }>;
/** Attribute dictionaries are renderer-owned, checked against the tag allowlist; never copied from author HTML. */

export interface Revision {
  readonly number: number;
  readonly state: ControlState;
  readonly values: Readonly<Record<string, Value>>;
  readonly tables: Readonly<Record<string, TableValue>>;
  readonly nodes: readonly ResolvedNode[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface Session {
  readonly program: Program;
  getRevision(): Revision;
  setControl(name: string, value: Scalar): Result<Revision>;
  setControls(update: ControlState): Result<Revision>;
  reset(): Result<Revision>;
  subscribe(listener: (revision: Revision) => void): () => void;
  destroy(): void;
}

export interface ReaderHandle {
  resetPresentation(): void;
  destroy(): void;
}

export interface MountOptions {
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  readonly assets: AssetStore;
}
/** Browser-only export from @tinta/reader; HTMLElement is not imported by core packages. */

export interface ReaderHost {
  readonly nativeElement: unknown;
}

export interface Asset {
  readonly path: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Uint8Array;
  readonly sha256: HexSha256;
}

export type AssetStore = ReadonlyMap<string, Asset>;

export interface StateEnvelope {
  readonly kind: "tinta-state";
  readonly formatVersion: "1.0";
  readonly sourceSha256: HexSha256;
  readonly controls: ControlState;
}

export interface Artifact {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly suggestedName: string;
  readonly sha256: HexSha256;
}

export type ExportOptions = Readonly<{
  format: "interactive" | "static";
  answers: "initial" | "current";
}>;

export interface OpenedBundle {
  readonly source: SourceInput;
  readonly assets: AssetStore;
}

export interface ImportColumn {
  readonly input: string;
  readonly name: string;
  readonly type: ScalarType;
}

export interface DataImportOptions {
  readonly name: string;
  readonly columns?: readonly ImportColumn[];
}

export interface DataImport {
  readonly source: string;
  readonly columns: readonly ImportColumn[];
  readonly rowCount: number;
}
