import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireCommandSync } from "./commands.mjs";

/** Temporarily disconnect only a disposable GitHub-hosted test machine. */
export function offlineInstalled(command) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(
    process.env.RUNNER_ENVIRONMENT,
    "github-hosted",
    "Offline adapter requires a disposable hosted runner",
  );
  if (process.platform === "linux") {
    const uid = String(process.getuid());
    const gid = String(process.getgid());
    return requireCommandSync(
      [
        "sudo",
        "--preserve-env",
        "unshare",
        "--net",
        "--",
        "bash",
        "-c",
        'ip link set lo up && exec setpriv --reuid="$1" --regid="$2" --init-groups "${@:3}"',
        "bash",
        uid,
        gid,
        ...command,
      ],
      {
        stdio: "inherit",
        env: { ...process.env, TINTA_CANDIDATE_OFFLINE: "network-namespace" },
      },
    );
  }
  const interfaces = Object.entries(networkInterfaces())
    .filter(([, addresses]) => addresses.some((address) => !address.internal))
    .map(([name]) => name);
  assert.ok(interfaces.length > 0, "No active network interface to isolate");
  let restore;
  let disconnect;
  let watchdog;
  if (process.platform === "darwin") {
    assert.ok(interfaces.every((name) => /^[a-z]+[0-9]+$/.test(name)));
    const restoreScript = interfaces
      .map((name) => `/sbin/ifconfig ${name} up`)
      .join("\n");
    const path = join(process.env.RUNNER_TEMP, "tinta-restore-network.sh");
    writeFileSync(path, `sleep 180\n${restoreScript}\n`);
    watchdog = spawn("sudo", ["sh", path], { detached: true, stdio: "ignore" });
    restore = () => {
      for (const name of interfaces)
        requireCommandSync(["sudo", "ifconfig", name, "up"]);
    };
    disconnect = () => {
      for (const name of interfaces)
        requireCommandSync(["sudo", "ifconfig", name, "down"]);
    };
  } else {
    assert.equal(process.platform, "win32");
    const query = requireCommandSync([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "ConvertTo-Json -Compress -InputObject @(Get-NetAdapter | Where-Object Status -eq Up | Select-Object -ExpandProperty InterfaceIndex)",
    ]).stdout;
    const indices = JSON.parse(query);
    assert.ok(
      Array.isArray(indices) &&
        indices.length > 0 &&
        indices.every(Number.isSafeInteger),
    );
    const selector = indices.join(",");
    const adapters = `Get-NetAdapter | Where-Object { $_.InterfaceIndex -in @(${selector}) }`;
    const enable = `${adapters} | Enable-NetAdapter -Confirm:$false`;
    watchdog = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", `Start-Sleep -Seconds 180; ${enable}`],
      { detached: true, stdio: "ignore" },
    );
    restore = () =>
      requireCommandSync(["powershell.exe", "-NoProfile", "-Command", enable]);
    disconnect = () =>
      requireCommandSync([
        "powershell.exe",
        "-NoProfile",
        "-Command",
        `${adapters} | Disable-NetAdapter -Confirm:$false`,
      ]);
  }
  watchdog.unref();
  // Keep the independent restoration timer alive even if the test process dies.
  try {
    disconnect();
    return requireCommandSync(command, {
      stdio: "inherit",
      timeout: 150000,
      env: {
        ...process.env,
        TINTA_CANDIDATE_OFFLINE: "hosted-interfaces-down",
      },
    });
  } finally {
    restore();
  }
}
