import type {
  CompilerOptions,
  Program,
  ProgramIR,
  Result,
  Span,
} from "@tinta-lang/types";
import { attempt, Budget, fail } from "./common.js";
import { compile, programs } from "./compiler.js";
import validate from "./program-validator.js";

import { inspect } from "./inspect.js";

function same(a: unknown, b: unknown, budget: Budget): boolean {
  budget.charge();
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    Array.isArray(a) === Array.isArray(b) &&
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every(
      (key) => Object.hasOwn(y, key) && same(x[key], y[key], budget),
    )
  );
}

export function decodeProgram(
  payload: unknown,
  options?: CompilerOptions,
): Result<Program> {
  const span: Span = {
    uri: "tinta:program",
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
  };
  const checked = attempt(() => {
    const budget = new Budget(span, "decode", options);
    inspect(payload, budget);
    if (!validate(payload)) fail("E_PROTOCOL", span, "decode");
    return { ir: payload as ProgramIR, budget };
  });
  if (!checked.ok) return checked;
  const { ir, budget } = checked.value;
  const compiled = compile(
    {
      uri: ir.sourceUri,
      profile: ir.profile,
      text: ir.source,
    },
    options,
  );
  if (!compiled.ok) return compiled;

  return attempt(() => {
    budget.charge(span, programs.get(compiled.value)!.compileOperations);
    if (ir.sourceSha256 !== compiled.value.sourceSha256)
      fail("E_HASH_MISMATCH", span, "decode");
    if (!same(ir, compiled.value, budget)) fail("E_PROTOCOL", span, "decode");
    return compiled.value;
  }, compiled.diagnostics);
}

export function encodeProgram(program: Program): ProgramIR {
  if (!programs.has(program))
    throw new TypeError("Only validated programs can be encoded.");
  return program;
}
