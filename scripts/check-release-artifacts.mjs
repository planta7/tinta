import { checkInventory } from "./release-candidate.mjs";
import { loadReleaseConfig } from "./release-contract.mjs";

const inventory = checkInventory(
  process.argv[2] ?? "build/distribution",
  loadReleaseConfig(),
);
console.log(
  `Verified ${inventory.targets.length} supplied archives; source dirty=${inventory.source.dirty}. This is a content check, not producer authentication.`,
);
