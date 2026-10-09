import { spawnSync } from "node:child_process";

export function toolInvocation(
  command,
  {
    platform = process.platform,
    node = process.execPath,
    env = process.env,
  } = {},
) {
  const [tool, ...args] = command;
  if (tool === "node") return [node, ...args];
  if (tool === "python3")
    return [
      env.TINTA_PYTHON || (platform === "win32" ? "python" : tool),
      ...args,
    ];
  if (tool === "pnpm") {
    // Reuse pnpm's JavaScript entry point instead of executing a Windows shim
    // or converting paths and arguments into a shell command.
    if (
      env.npm_execpath &&
      /(?:^|[/\\])pnpm\.(?:c?js|mjs)$/.test(env.npm_execpath)
    )
      return [node, env.npm_execpath, ...args];
    if (platform === "win32")
      throw new Error("Run this verification command through pnpm on Windows.");
  }
  return command;
}

export function runCommandSync(command, options = {}) {
  const [executable, ...args] = toolInvocation(command, {
    env: options.env ?? process.env,
  });
  return spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    shell: false,
  });
}

export function requireCommandSync(command, options = {}) {
  const result = runCommandSync(command, options);
  if (result.error || result.status !== 0)
    throw new Error(
      `Command failed: ${JSON.stringify(command)}\n` +
        (result.error?.message ?? result.stderr ?? "No exit status"),
    );
  return result;
}
