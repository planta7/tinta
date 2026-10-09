import { parseRecovering } from "@tinta/syntax";
import { compile, createSession, encodeProgram } from "@tinta/engine";
import { limits } from "@tinta/artifacts";
import { base, baseKeys, exact, integer } from "./protocol.js";

let revision = -1;
let request = -1;
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!base(data)) return;
  const header = {
    protocol: data.protocol,
    documentId: data.documentId,
    capability: data.capability,
    requestId: data.requestId,
    sourceRevision: data.sourceRevision,
  };
  if (
    data.kind === "cancel" &&
    exact(data, [...baseKeys, "targetRequestId"]) &&
    integer(data.targetRequestId)
  ) {
    self.postMessage({
      ...header,
      kind: "cancelled",
      targetRequestId: data.targetRequestId,
    });
    return;
  }
  if (
    data.kind !== "compile" ||
    !exact(data, [...baseKeys, "source", "uri", "profile"]) ||
    typeof data.source !== "string" ||
    new TextEncoder().encode(data.source).length > limits.sourceBytes ||
    typeof data.uri !== "string" ||
    data.uri.length > 2048 ||
    !["markdown", "tinta"].includes(String(data.profile)) ||
    data.sourceRevision <= revision ||
    data.requestId <= request
  )
    return;
  revision = data.sourceRevision;
  request = data.requestId;
  const input = {
    text: data.source,
    uri: data.uri,
    profile: data.profile as "markdown" | "tinta",
  };
  const parsed = parseRecovering(input);
  const highlights = parsed.ok
    ? parsed.value.tokens
        .filter(
          (item) => item.kind === "directive" || item.kind === "interpolation",
        )
        .map((item) => ({
          from: item.span.start.offset,
          to: item.span.end.offset,
        }))
    : [];
  const result = compile(input);
  if (!result.ok) {
    self.postMessage({
      ...header,
      kind: "rejected",
      highlights,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const session = createSession(result.value);
  if (!session.ok) {
    self.postMessage({
      ...header,
      kind: "rejected",
      highlights,
      diagnostics: session.diagnostics,
    });
    return;
  }
  session.value.destroy();
  self.postMessage({
    ...header,
    kind: "compiled",
    highlights,
    program: encodeProgram(result.value),
    diagnostics: result.diagnostics,
  });
});
