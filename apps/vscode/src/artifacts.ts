import { Worker } from "node:worker_threads";
import { ArtifactFailure } from "@tinta/types/common";
import type { ArtifactReply, ArtifactRequest } from "./artifact-protocol.js";

/** One fixed, disposable worker per bounded operation; author text selects no code. */
export function runArtifact(
  request: ArtifactRequest,
  signal: AbortSignal,
): Promise<ArtifactReply> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./artifact-worker.mjs", import.meta.url),
    );
    let finished = false;
    const finish = (error?: Error, reply?: ArtifactReply) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else resolve(reply!);
    };
    const cancelled = () =>
      finish(new ArtifactFailure("E_IO", "Operation cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          new ArtifactFailure("E_WORKER_TIMEOUT", "Artifact worker timed out."),
        ),
      3000,
    );
    signal.addEventListener("abort", cancelled, { once: true });
    worker.once("error", () => finish(new Error("Artifact worker failed.")));
    worker.once("exit", () => finish(new Error("Artifact worker exited.")));
    worker.once("message", (reply: ArtifactReply) => {
      if (reply.kind === "error")
        finish(
          reply.code === "E_INTERNAL"
            ? new Error("Artifact worker failed.")
            : new ArtifactFailure(reply.code, reply.message),
        );
      else finish(undefined, reply);
    });
    try {
      worker.postMessage(request);
    } catch {
      finish(new Error("Artifact worker transport failed."));
    }
  });
}
