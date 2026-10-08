import { pathToFileURL } from "node:url";
export function requireCapability(suite, capability) {
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
  process.exitCode = capabilityExitCode(process.argv[2], process.argv[3]);
