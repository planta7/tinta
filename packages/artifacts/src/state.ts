import type {
  ControlState,
  Program,
  Result,
  Session,
  StateEnvelope,
} from "@tinta/types";
import { createSession } from "@tinta/engine";
import { attempt, object, reject, strictJson, unwrap } from "./common.js";

export function createStateSnapshot(session: Session): StateEnvelope {
  return {
    kind: "tinta-state",
    formatVersion: "1.0",
    sourceSha256: session.program.sourceSha256,
    controls: Object.fromEntries(
      Object.entries(session.getRevision().state).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  };
}
export function validateStateSnapshot(
  program: Program,
  payload: unknown,
): Result<ControlState> {
  return attempt(() => {
    const envelope = object(
      typeof payload === "string" ? strictJson(payload) : payload,
      ["kind", "formatVersion", "sourceSha256", "controls"],
      "E_SNAPSHOT",
    );
    if (
      envelope.kind !== "tinta-state" ||
      envelope.formatVersion !== "1.0" ||
      envelope.sourceSha256 !== program.sourceSha256
    )
      reject("E_SNAPSHOT", "Snapshot does not match this source.");
    if (
      !envelope.controls ||
      typeof envelope.controls !== "object" ||
      Array.isArray(envelope.controls)
    )
      reject("E_SNAPSHOT", "Invalid snapshot controls.");
    const session = unwrap(
      createSession(program, { baseline: envelope.controls as ControlState }),
    );
    try {
      return session.getRevision().state;
    } finally {
      session.destroy();
    }
  });
}
