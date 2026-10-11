import type {
  CompilerOptions,
  Diagnostic,
  Phase,
  Result,
  Span,
} from "@tinta-lang/types";
import { registry } from "./registry.js";

export class Failure extends Error {
  readonly diagnostic: Diagnostic;
  readonly diagnostics: readonly Diagnostic[];

  constructor(input: Diagnostic | readonly Diagnostic[]) {
    const diagnostics = Array.isArray(input) ? input : [input as Diagnostic];
    super(diagnostics[0]!.message);
    this.diagnostic = diagnostics[0]!;
    this.diagnostics = diagnostics;
  }
}

export function fail(
  code: keyof typeof registry.errors,
  span: Span,
  phase: Phase = "type",
): never {
  throw new Failure({
    code,
    severity: "error",
    phase,
    message: registry.errors[code],
    span,
  });
}

export function orderedDiagnostics(
  diagnostics: readonly Diagnostic[],
  maximum = 100,
): readonly Diagnostic[] {
  const phases = [
    "decode",
    "parse",
    "bind",
    "type",
    "evaluate",
    "assets",
    "export",
    "host",
  ];
  const sorted = [...diagnostics].sort(
    (a, b) =>
      Number(a.details?.limitName === "diagnostics") -
        Number(b.details?.limitName === "diagnostics") ||
      phases.indexOf(a.phase) - phases.indexOf(b.phase) ||
      a.span.start.offset - b.span.start.offset ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  if (sorted.length > maximum) {
    const last = sorted[maximum - 1]!;
    return [
      ...sorted.slice(0, maximum - 1),
      {
        code: "E_LIMIT",
        severity: "error",
        phase: last.phase,
        message: "The diagnostic limit was exceeded.",
        span: last.span,
        details: {
          limitName: "diagnostics",
          observed: sorted.length,
          maximum,
        },
      },
    ];
  }

  return sorted;
}

export function attempt<T>(
  run: () => T,
  diagnostics: readonly Diagnostic[] = [],
  maximumDiagnostics = 100,
): Result<T> {
  try {
    const value = run();
    return {
      ok: true,
      value,
      diagnostics: orderedDiagnostics(diagnostics, maximumDiagnostics),
    };
  } catch (error) {
    if (error instanceof Failure)
      return {
        ok: false,
        diagnostics: orderedDiagnostics(
          [...diagnostics, ...error.diagnostics],
          maximumDiagnostics,
        ),
      };
    throw error;
  }
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export class Budget {
  readonly limits: Record<string, number> = { ...registry.limits };
  private operations = 0;
  get used(): number {
    return this.operations;
  }

  constructor(
    readonly span: Span,
    readonly phase: Phase,
    options?: CompilerOptions,
  ) {
    for (const [key, value] of Object.entries(options?.limits ?? {})) {
      if (
        !Object.hasOwn(this.limits, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > this.limits[key]!
      )
        fail("E_LIMIT", span, phase);
      this.limits[key] = value;
    }
  }

  limit(name: string, observed: number, span = this.span): void {
    const maximum = this.limits[name]!;
    if (observed > maximum)
      throw new Failure({
        code: "E_LIMIT",
        severity: "error",
        phase: this.phase,
        message: "A resource limit was exceeded.",
        span,
        details: { limitName: name, observed, maximum },
      });
  }

  charge(span = this.span, amount = 1): void {
    this.operations += amount;
    this.limit(
      this.phase === "evaluate" ? "evaluationOperations" : "compileOperations",
      this.operations,
      span,
    );
  }
}

export const label = (name: string): string => name.replaceAll("_", " ");
export const scalarType = (
  value: string | number | boolean,
): "text" | "number" | "boolean" =>
  typeof value === "string"
    ? "text"
    : typeof value === "number"
      ? "number"
      : "boolean";
