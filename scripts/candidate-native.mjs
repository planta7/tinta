import {
  existsSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
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
  } catch (error) {
    const diagnostics = `${evidencePath}.diagnostics`;
    mkdirSync(diagnostics, { recursive: true });
    const logs = join(root, "portable/user-data/logs");
    if (existsSync(logs))
      cpSync(logs, join(diagnostics, "logs"), { recursive: true });
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (
          /^ui-(request|response)\.json$|^ui-failure-\d+\.(png|txt)$/.test(name)
        )
          copyFileSync(join(root, name), join(diagnostics, name));
      }
    }
    throw error;
  } finally {
    const result = join(root, "result.json");
    if (existsSync(result)) copyFileSync(result, evidencePath);
  }
}

export function runNativeModes(modes, execute) {
  const failures = [];
  for (const mode of modes) {
    try {
      execute(mode);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Native installed checks failed.");
}
