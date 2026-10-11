import { parentPort, type MessagePort } from "node:worker_threads";
import { authoring } from "./authoring.js";
import { analyze } from "@tinta-lang/language-service";
import type {
  AnalysisRequest,
  AnalysisReply,
  ReleaseRequest,
} from "./protocol.js";

export function startWorker(
  port: Pick<MessagePort, "on" | "postMessage"> | null,
): void {
  if (!port) throw new Error("Analysis requires a worker port.");
  let cached: AnalysisReply | undefined;
  port.on("message", (request: AnalysisRequest | ReleaseRequest) => {
    if ("release" in request) {
      if (
        cached?.request.uri === request.release.uri &&
        cached.request.instance === request.release.instance
      )
        cached = undefined;
      return;
    }
    const { uri, instance, version, text } = request;
    const result =
      cached?.request.uri === uri &&
      cached.request.instance === instance &&
      cached.request.version === version &&
      cached.result.ok &&
      cached.result.value.sourceText === text
        ? cached.result
        : analyze(
            { uri, profile: "tinta", text },
            {
              documentInstance: instance,
              editorVersion: version,
              sourceRevision: version,
            },
          );
    const reply: AnalysisReply = {
      request: {
        uri,
        instance,
        version,
        ...(request.query ? { query: request.query } : {}),
      },
      result,
      ...(request.query
        ? {
            authoring: result.ok
              ? authoring(result.value, request.query.params)
              : null,
          }
        : {}),
    };
    cached = reply;
    port.postMessage(reply);
  });
}

startWorker(parentPort);
