import { parentPort } from "node:worker_threads";
import { operate } from "./operation.js";
import type { ArtifactRequest } from "../artifact-protocol.js";

if (!parentPort) throw new Error("Artifact worker requires a parent port.");
parentPort.once("message", (request: ArtifactRequest) => {
  void operate(request).then((reply) => parentPort!.postMessage(reply));
});
