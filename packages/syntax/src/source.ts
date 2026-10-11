import type {
  CompilerOptions,
  Diagnostic,
  Position,
  SourceInput,
  Span,
} from "@tinta-lang/types";
import { registry } from "./registry.js";

export class SyntaxFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

import { decodeUtf8, encodeUtf8 } from "@tinta-lang/types/utf8";
export { decodeUtf8, encodeUtf8 } from "@tinta-lang/types/utf8";

export class Source {
  readonly lexemes: {
    raw: string;
    start: number;
    end: number;
  }[] = [];
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly lines = [0];
  readonly limits: Readonly<Record<string, number>>;
  readonly diagnostics: Diagnostic[] = [];
  private readonly counts = new Map<string, number>();

  constructor(
    readonly input: SourceInput,
    options: CompilerOptions = {},
  ) {
    this.limits = { ...registry.limits };
    const limits: Record<string, number> = { ...registry.limits };

    for (const [name, value] of Object.entries(options.limits ?? {})) {
      if (
        !(name in limits) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > limits[name]!
      )
        this.fail("E_LIMIT", 0, 0, "Invalid or weakened resource limit.", {
          limitName: name,
          observed: value,
          maximum: limits[name] ?? 0,
        });
      limits[name] = value;
    }

    this.limits = limits;
    if (input.bytes) this.limit("sourceBytes", input.bytes.length, 0);
    else this.limit("sourceBytes", input.text.length, 0);

    try {
      this.text = input.bytes ? decodeUtf8(input.bytes) : input.text;
      this.bytes = input.bytes ? input.bytes.slice() : encodeUtf8(this.text);
    } catch {
      this.fail(
        "E_ENCODING",
        0,
        0,
        "Source must be valid UTF-8 scalar text.",
        undefined,
        "decode",
      );
    }

    this.limit("sourceBytes", this.bytes.length, 0);
    let start = 0;

    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i] === "\r" || this.text[i] === "\n") {
        this.limit("sourceLineUnits", i - start, start);
        if (this.text[i] === "\r" && this.text[i + 1] === "\n") i++;
        start = i + 1;
        this.lines.push(start);
      }
    }
    this.limit("sourceLineUnits", this.text.length - start, start);
  }

  position(offset: number): Position {
    let lo = 0,
      hi = this.lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lines[mid]! <= offset) lo = mid;
      else hi = mid;
    }
    return {
      offset,
      line: lo + 1,
      column: offset - this.lines[lo]! + 1,
    };
  }

  span(start: number, end: number): Span {
    return {
      uri: this.input.uri,
      start: this.position(start),
      end: this.position(end),
    };
  }

  fail(
    code: string,
    start: number,
    end: number,
    message: string,
    details?: Diagnostic["details"],
    phase: Diagnostic["phase"] = "parse",
  ): never {
    throw new SyntaxFailure({
      code,
      severity: "error",
      phase,
      message,
      span: this.span(start, end),
      ...(details ? { details } : {}),
    });
  }

  warn(code: string, start: number, end: number, message: string): void {
    this.limit("diagnostics", this.diagnostics.length + 1, start);
    this.diagnostics.push({
      code,
      severity: "warning",
      phase: "parse",
      message,
      span: this.span(start, end),
    });
  }

  limit(
    name: string,
    observed: number,
    at: number,
    maximum = this.limits[name]!,
  ): void {
    if (observed > maximum)
      this.fail("E_LIMIT", at, at, `Resource limit exceeded: ${name}.`, {
        limitName: name,
        observed,
        maximum,
      });
  }

  get compileOperations(): number {
    return this.counts.get("compileOperations") ?? 0;
  }

  charge(name: string, at: number, amount = 1): void {
    const n = (this.counts.get(name) ?? 0) + amount;
    this.counts.set(name, n);
    this.limit(name, n, at);
  }
}
