import { runCommandSync } from "./commands.mjs";

const result = runCommandSync(
  ["pnpm", "exec", "vitest", "run", "--testTimeout=120000"],
  {
    stdio: "inherit",
    env: { ...process.env, TINTA_PROPERTY_RUNS: "10000" },
  },
);
process.exitCode = result.status ?? 1;
