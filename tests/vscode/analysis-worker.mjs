import { parentPort } from "node:worker_threads";
import {
  compile,
  createSession,
  encodeProgram,
} from "../../packages/engine/dist/index.js";

parentPort.on("message", (message) => {
  if (message === "stall") {
    parentPort.postMessage({ kind: "entered" });
    // Deliberate synchronous fault injection, never document-selected code.
    for (;;) Math.sqrt(2);
  }
  const compiled = compile({
    uri: "tinta:probe",
    profile: "tinta",
    text: "@let amount = 2\n{{ amount }}\n",
  });
  if (!compiled.ok) throw new Error("Probe compilation failed");
  const created = createSession(compiled.value);
  if (!created.ok) throw new Error("Probe initial evaluation failed");
  created.value.destroy();
  parentPort.postMessage({
    kind: "compiled",
    program: encodeProgram(compiled.value),
    node: process.versions.node,
  });
});
