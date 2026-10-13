import { requireCommandSync } from "./commands.mjs";

const commands = [
  ["node", "scripts/release-contract.mjs"],
  [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "tests/unit/prepare-release.test.mjs",
    "tests/unit/release-pr.test.mjs",
    "tests/unit/release-contract.test.mjs",
  ],
  ["node", "scripts/distribution-package.mjs"],
  [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--config",
    "scripts/distribution-vitest.config.js",
  ],
  ["node", "scripts/check-release-artifacts.mjs", "build/distribution"],
  ["pnpm", "exec", "vitest", "run", "tests/unit/cli.test.mjs"],
  ["pnpm", "test:vscode:unit"],
  [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "tests/browser/artifacts.test.mjs",
    "tests/browser/studio.test.mjs",
  ],
];
for (const command of commands) {
  console.log(`Running ${command.join(" ")}`);
  requireCommandSync(command, { stdio: "inherit" });
}
