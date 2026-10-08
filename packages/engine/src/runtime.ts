import type { Program, ProgramIR, Result, Span } from "@tinta/types";
import { hash, encodeUtf8 } from "@tinta/types/common";
import { attempt, Budget, fail, freeze } from "./common.js";
import { bind } from "./binding.js";
import { programs } from "./programs.js";
import { inspect } from "./inspect.js";
import validate from "./program-validator.js";
export { createSession } from "./session.js";

/** Rehydrate exact export-time validated bytes, authenticated by the trusted shell. */
export function restoreExportProgram(
  payload: unknown,
  expectedHash: string,
): Result<Program> {
  const span: Span = {
    uri: "tinta:program",
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
  };
  return attempt(() => {
    const budget = new Budget(span, "decode");
    const serialized = JSON.stringify(payload);
    if (
      serialized.length > 41943040 ||
      hash(encodeUtf8(serialized)) !== expectedHash
    )
      fail("E_HASH_MISMATCH", span, "decode");
    inspect(payload, budget);
    if (!validate(payload)) fail("E_PROTOCOL", span, "decode");
    const ir = payload as ProgramIR;
    if (hash(encodeUtf8(ir.source)) !== ir.sourceSha256)
      fail("E_HASH_MISMATCH", span, "decode");
    const bound = bind(ir, budget, new Map());
    const program = freeze(ir) as Program;
    programs.set(program, bound);
    return program;
  });
}
