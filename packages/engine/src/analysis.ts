import type { Program, ScalarType } from "@tinta/types";
import type { EditorType } from "@tinta/types/editor";
import { freeze } from "./common.js";
import { programs } from "./programs.js";

export interface AnalyzedBinding {
  readonly name: string;
  readonly type: EditorType;
}

/** Read-only compiler facts; never expose the private binding maps or alter IR. */
export function analyzeProgram(program: Program): readonly AnalyzedBinding[] {
  const bound = programs.get(program);
  if (!bound) throw new TypeError("Expected a compiled or decoded program.");
  return freeze(
    program.declarations.map(({ name }): AnalyzedBinding => {
      const type = bound.types.get(name)!;
      return {
        name,
        type:
          typeof type !== "string"
            ? { kind: "table", columns: type.map((column) => ({ ...column })) }
            : type.startsWith("list:")
              ? { kind: "list", scalar: type.slice(5) as ScalarType | "never" }
              : { kind: "scalar", scalar: type as ScalarType },
      };
    }),
  );
}
