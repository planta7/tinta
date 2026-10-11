import { Worker } from "node:worker_threads";

export function startResidentSampler(file) {
  const worker = new Worker(file);
  let finish;
  let fail;
  const result = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Retain failures until the performance run consumes the result.
  result.catch(() => {});
  const ready = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`Resident sampler exited before readiness (${code}).`));
    });
  });
  worker.on("message", (message) => {
    if (message.type === "result") finish(message);
  });
  worker.once("error", fail);
  worker.once("exit", (code) => {
    fail(new Error(`Resident sampler exited before its result (${code}).`));
  });
  return {
    ready,
    async stop() {
      worker.postMessage("stop");
      return result;
    },
    async dispose() {
      await worker.terminate();
    },
  };
}
