import { expect, test } from "vitest";
import { win32 } from "node:path";
import { toolInvocation, runCommandSync } from "../../scripts/commands.mjs";
import { deploymentTemporaryRoot } from "../../scripts/installed-cli-directory.mjs";

test("Windows deployment resolves workspace dependencies across runner volumes", () => {
  const workspace = "D:\\a\\tinta\\tinta";
  const systemTemporary = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
  const source = win32.join(workspace, "packages", "artifacts");
  const previous = win32.join(systemTemporary, "tinta-installed", "package");
  expect(win32.resolve(previous, win32.relative(previous, source))).not.toBe(
    win32.join(previous, win32.relative(previous, source)),
  );
  const base = deploymentTemporaryRoot("win32", workspace, systemTemporary);
  const deployed = win32.join(base, "tinta-installed", "package");
  expect(win32.join(deployed, win32.relative(deployed, source))).toBe(source);
  expect(win32.relative(workspace, base)).toBe("..");
  expect(deploymentTemporaryRoot("darwin", "/source", "/tmp")).toBe("/tmp");
  expect(deploymentTemporaryRoot("linux", "/source", "/tmp")).toBe("/tmp");
});

test("Windows invocation keeps Unicode paths, spaces and shell characters as literal arguments", () => {
  const args = [
    "--dir",
    "C:\\checks á with spaces",
    "exec",
    "tinta",
    "a & b.tinta",
    "%PATH%",
    "$(command)",
  ];
  const invocation = toolInvocation(["pnpm", ...args], {
    platform: "win32",
    node: "C:\\Program Files\\nodejs\\node.exe",
    env: { npm_execpath: "C:\\tools\\pnpm\\bin\\pnpm.cjs" },
  });
  expect(invocation).toEqual([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\tools\\pnpm\\bin\\pnpm.cjs",
    ...args,
  ]);
  expect(() =>
    toolInvocation(["pnpm", ...args], { platform: "win32", env: {} }),
  ).toThrow("through pnpm");
  expect(
    toolInvocation(["python3", "--version"], {
      platform: "win32",
      env: { TINTA_PYTHON: "C:\\Python tools\\python.exe" },
    }),
  ).toEqual(["C:\\Python tools\\python.exe", "--version"]);
});

test("tool execution preserves literal arguments and propagates nonzero exits", () => {
  const args = ["a b", "á", "&", "%PATH%", "$(command)"];
  const result = runCommandSync([
    "node",
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 7;",
    ...args,
  ]);
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual(args);
  const missing = runCommandSync(["tinta-nonexistent-verification-tool"]);
  expect(missing.status).toBe(null);
  expect(missing.error.code).toBe("ENOENT");
});
