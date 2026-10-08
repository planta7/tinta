import type {
  CompilerOptions,
  Diagnostic,
  Position,
  SourceInput,
  Span,
} from "@tinta/types";
import { registry } from "./registry.js";

export class SyntaxFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

/** Strict, portable UTF-8. Reject overlong encodings, surrogates and truncation. */
export function decodeUtf8(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let part = "";

  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++]!;
    let point = a;
    let count = 0;
    let minimum = 0;

    if (a >= 0xc2 && a <= 0xdf) {
      count = 1;
      point = a & 31;
      minimum = 0x80;
    } else if (a >= 0xe0 && a <= 0xef) {
      count = 2;
      point = a & 15;
      minimum = 0x800;
    } else if (a >= 0xf0 && a <= 0xf4) {
      count = 3;
      point = a & 7;
      minimum = 0x10000;
    } else if (a >= 0x80) throw new Error("Invalid UTF-8 leading byte.");

    for (let j = 0; j < count; j++) {
      const b = bytes[i++];
      if (b === undefined || (b & 0xc0) !== 0x80)
        throw new Error("Invalid UTF-8 continuation.");
      point = (point << 6) | (b & 63);
    }

    if (
      point < minimum ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      throw new Error("Invalid UTF-8 scalar.");

    part += String.fromCodePoint(point);
    if (part.length >= 4096) {
      chunks.push(part);
      part = "";
    }
  }

  return chunks.join("") + part;
}

export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];

  for (const char of text) {
    const c = char.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff)
      throw new Error("Unpaired UTF-16 surrogate.");
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 65536)
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }

  return Uint8Array.from(bytes);
}

export class Source {
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
