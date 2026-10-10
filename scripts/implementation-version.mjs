import { writeFile } from "node:fs/promises";
import { loadReleaseConfig } from "./release-contract.mjs";

export const implementationVersion =
  loadReleaseConfig().versions.implementation;

export function versionModule(version = implementationVersion) {
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(version))
    throw new Error("Invalid implementation version.");
  return `export const implementationVersion = ${JSON.stringify(version)};\n`;
}

export async function writeImplementationVersion() {
  await writeFile("packages/types/dist/version.js", versionModule());
}
