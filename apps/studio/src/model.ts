import { createSession } from "@tinta/engine";
import type {
  ControlDefinition,
  ControlState,
  Program,
  Result,
  Session,
  SourceProfile,
} from "@tinta/types";

export function signature(control: ControlDefinition): string {
  return JSON.stringify([
    control.kind,
    control.initial,
    ...(control.kind === "slider"
      ? [control.min, control.max, control.step]
      : []),
    ...(control.kind === "choice" ? control.options : []),
  ]);
}

export function reconcile(
  program: Program,
  previous?: Session,
): {
  result: Result<Session>;
  reset: string[];
} {
  const initial = createSession(program);
  if (!initial.ok || !previous) return { result: initial, reset: [] };
  const old = new Map(
    previous.program.declarations.filter(isControl).map((d) => [d.name, d]),
  );
  const answers: Record<string, string | number | boolean> =
    Object.create(null);
  const reset: string[] = [];

  for (const control of program.declarations.filter(isControl)) {
    const before = old.get(control.name);
    if (before && signature(before) === signature(control)) {
      answers[control.name] = previous.getRevision().state[control.name]!;
    } else {
      answers[control.name] = control.initial;
      reset.push(control.name);
    }
  }

  const changed = initial.value.setControls(answers);
  if (!changed.ok) {
    initial.value.destroy();
    return {
      result: createSession(program),
      reset: program.declarations.filter(isControl).map((d) => d.name),
    };
  }

  return { result: initial, reset };
}

export function isControl(
  value: Program["declarations"][number],
): value is ControlDefinition {
  return ["slider", "toggle", "choice"].includes(value.kind);
}

export function safeFilename(name: string): string {
  return (
    [...name]
      .map((char) =>
        char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char,
      )
      .join("")
      .replace(/[. ]+$/, "") || "untitled.tinta"
  );
}

export function stem(name: string): string {
  return safeFilename(name).replace(/(?:\.tinta\.zip|\.tinta|\.md)$/i, "");
}

export function profileFor(name: string): SourceProfile | undefined {
  if (/\.md$/i.test(name)) return "markdown";
  if (/\.tinta(?:\.zip)?$/i.test(name)) return "tinta";
  return undefined;
}

export function sameState(left: ControlState, right: ControlState): boolean {
  return (
    JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort())
  );
}

export function insertionBoundary(program: Program, offset: number): number {
  for (const item of [...program.flow, ...program.declarations]) {
    if (item.span.start.offset <= offset && offset < item.span.end.offset)
      return item.span.end.offset;
  }
  return offset;
}
