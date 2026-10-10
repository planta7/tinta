import { compile, createSession, encodeProgram } from "@tinta/engine";
import { encodeUtf8, hash } from "@tinta/types/common";
import { sourceIdentity } from "@tinta/types/webview";
import type { ProgramIR, Result } from "@tinta/types";
import type { SourceIdentity } from "@tinta/types/editor";

export interface PreviewCompilation {
  readonly identity: SourceIdentity;
  readonly result: Result<ProgramIR>;
}

/** Supplied verified source only; the caller supervises this synchronous work. */
export function preparePreview(
  identity: SourceIdentity,
  text: string,
): PreviewCompilation {
  if (
    !sourceIdentity(identity) ||
    hash(encodeUtf8(text)) !== identity.sourceSha256
  )
    throw new TypeError("Preview source identity mismatch.");
  const compiled = compile({
    uri: identity.uri,
    profile: identity.profile,
    text,
  });
  if (!compiled.ok) return { identity, result: compiled };
  const session = createSession(compiled.value);
  if (!session.ok) return { identity, result: session };
  try {
    return {
      identity,
      result: {
        ok: true,
        value: encodeProgram(compiled.value),
        diagnostics: compiled.diagnostics,
      },
    };
  } finally {
    session.value.destroy();
  }
}
