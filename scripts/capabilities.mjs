import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function requireCapability(suite, capability) {
  if (["parsing", "semantics"].includes(capability) && suite === "conformance")
    return;
  if (capability === "infrastructure" && suite === "browser") return;
  throw new Error(
    `NOT_IMPLEMENTED: ${suite}/${capability ?? "product"}; The workspace provides infrastructure tests only`,
  );
}

export function capabilityExitCode(suite, capability, report = console.error) {
  try {
    requireCapability(suite, capability);
    return 0;
  } catch (error) {
    report(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  if (capabilityExitCode(process.argv[2], process.argv[3]) !== 0)
    process.exitCode = 1;
  else if (
    process.argv[2] === "conformance" &&
    ["parsing", "semantics"].includes(process.argv[3])
  )
    process.exitCode =
      spawnSync(
        process.execPath,
        [
          process.argv[3] === "parsing"
            ? "conformance/runner/parse.mjs"
            : "conformance/runner/semantic.mjs",
        ],
        {
          stdio: "inherit",
        },
      ).status ?? 1;
