import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { requireCommandSync } from "./commands.mjs";
import { offlineInstalled } from "./candidate-offline.mjs";

export function runNativeMode(
  invocation,
  root,
  evidencePath,
  {
    offline = false,
    run = requireCommandSync,
    isolate = offlineInstalled,
  } = {},
) {
  try {
    if (offline) isolate(invocation);
    else run(invocation, { stdio: "inherit" });
  } finally {
    const result = join(root, "result.json");
    if (existsSync(result)) copyFileSync(result, evidencePath);
  }
}
