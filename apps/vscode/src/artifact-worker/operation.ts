import { compile, createSession } from "@tinta-lang/engine";
import {
  ArtifactFailure,
  enrichMarkdown,
  exportHtml,
  imageDestinations,
  openBundle,
  packSource,
  unwrap,
} from "@tinta-lang/artifacts";
import type { ArtifactReply, ArtifactRequest } from "../artifact-protocol.js";

/** Supplied bytes only. The worker has no file grants or native editor API. */
export async function operate(
  request: ArtifactRequest,
): Promise<ArtifactReply> {
  try {
    if (request.kind === "open")
      return { kind: "open", bundle: unwrap(await openBundle(request.bytes)) };
    if (request.kind === "enrich")
      return {
        kind: "enrich",
        enrichment: unwrap(enrichMarkdown(request.source)),
      };

    const program = unwrap(compile(request.source));
    const initial = unwrap(createSession(program));
    initial.destroy();
    const session = unwrap(
      createSession(
        program,
        request.baseline ? { baseline: request.baseline } : undefined,
      ),
    );
    try {
      if (request.kind === "inspect")
        return {
          kind: "inspect",
          destinations: imageDestinations(
            request.format === "static"
              ? session.getRevision().nodes
              : program.flow,
          ),
        };
      return {
        kind: "produce",
        artifact:
          request.format === "bundle"
            ? unwrap(await packSource(program, request.assets))
            : unwrap(
                await exportHtml(session, request.assets, {
                  format: request.format,
                  answers: request.baseline ? "current" : "initial",
                }),
              ),
      };
    } finally {
      session.destroy();
    }
  } catch (error) {
    return {
      kind: "error",
      code: error instanceof ArtifactFailure ? error.code : "E_INTERNAL",
      message:
        error instanceof ArtifactFailure && error.code !== "E_INTERNAL"
          ? error.message
          : "Artifact worker failed.",
    };
  }
}
