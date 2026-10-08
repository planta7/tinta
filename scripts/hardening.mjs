import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--testTimeout=120000"],
  {
    stdio: "inherit",
    env: { ...process.env, TINTA_PROPERTY_RUNS: "10000" },
  },
);
process.exitCode = result.status ?? 1;
