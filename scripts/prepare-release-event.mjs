import { readFileSync } from "node:fs";
import { prepareCheckout, readRequest } from "./prepare-release.mjs";
import { loadReleaseConfig } from "./release-contract.mjs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
  throw new Error("Release preparation requires an explicit dispatch");
}
loadReleaseConfig();
prepareCheckout(readRequest(event.inputs.request));
