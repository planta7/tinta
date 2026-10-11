import { parentPort } from "node:worker_threads";
import { residentBytes } from "./resident-memory.mjs";

const baselineRss = await residentBytes();
let peakRss = baselineRss;
let sampling = false;
let pendingSample = Promise.resolve();
let samplingError;
const timer = setInterval(() => {
  if (sampling) return;
  sampling = true;
  pendingSample = residentBytes()
    .then((rss) => {
      peakRss = Math.max(peakRss, rss);
    })
    .catch((error) => {
      samplingError ??= error;
    })
    .finally(() => {
      sampling = false;
    });
}, 100);
parentPort.once("message", async (message) => {
  if (message !== "stop") throw new Error("Unknown sampler request.");
  clearInterval(timer);
  await pendingSample;
  if (samplingError) throw samplingError;
  parentPort.postMessage({ type: "result", baselineRss, peakRss });
  parentPort.close();
});
parentPort.postMessage({ type: "ready", baselineRss });
