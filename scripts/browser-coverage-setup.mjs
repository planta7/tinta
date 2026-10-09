import { mkdir, rm } from "node:fs/promises";

export const fragmentDirectory =
  "reports/verification/studio-browser-fragments";

export default async function setup() {
  await rm(fragmentDirectory, { recursive: true, force: true });
  await mkdir(fragmentDirectory, { recursive: true });
  for (const name of ["browser", "preview"])
    await rm(`reports/verification/studio-${name}-coverage.json`, {
      force: true,
    });
}
