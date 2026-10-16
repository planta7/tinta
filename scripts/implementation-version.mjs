import { writeFile } from "node:fs/promises";
import { loadReleaseConfig } from "./release-contract.mjs";

const versions = loadReleaseConfig().versions;
export const implementationVersion = versions.implementation;
export const studioVersion = versions.studio ?? implementationVersion;

export function versionModule(
  version = implementationVersion,
  name = "implementationVersion",
) {
  if (!["implementationVersion", "cliVersion"].includes(name))
    throw new Error("Invalid version module name.");
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(version))
    throw new Error("Invalid implementation version.");
  return `export const ${name} = ${JSON.stringify(version)};\n`;
}

export async function writeImplementationVersion() {
  await writeFile("packages/types/dist/version.js", versionModule());
}

export async function writeCliVersion() {
  await writeFile(
    "packages/cli/dist/version.js",
    versionModule(studioVersion, "cliVersion"),
  );
}
