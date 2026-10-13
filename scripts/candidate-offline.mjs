import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireCommandSync } from "./commands.mjs";

function windowsRestoration(selector, enable) {
  const endpoints = [
    process.env.GITHUB_SERVER_URL ?? "https://github.com",
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    process.env.ACTIONS_RESULTS_URL,
  ].filter(Boolean);
  const hosts = [
    ...new Set(
      endpoints.map((endpoint) => {
        let host;
        try {
          host = new URL(endpoint).hostname;
        } catch {
          throw new Error("Invalid hosted network endpoint.");
        }
        assert.match(host, /^[a-z0-9.-]+$/i, "Invalid hosted DNS name");
        return host;
      }),
    ),
  ];
  const names = hosts.map((host) => `'${host}'`).join(",");
  return `
$ErrorActionPreference = 'Stop'
${enable}
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ($true) {
  try {
    $configurations = Get-NetIPConfiguration | Where-Object {
      $_.InterfaceIndex -in @(${selector})
    }
    $routed = $configurations | Where-Object {
      $_.IPv4Address -and $_.IPv4DefaultGateway
    }
    if (-not $routed) {
      throw 'Restored adapters do not have an IP address and default gateway yet.'
    }
    Clear-DnsClientCache
    foreach ($name in @(${names})) {
      Resolve-DnsName -Name $name -DnsOnly -QuickTimeout | Out-Null
    }
    Write-Output 'Hosted network IP routing and DNS restored.'
    break
  } catch {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Hosted network restoration exceeded 45 seconds: $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 500
  }
}
`;
}

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
    const restoration = windowsRestoration(selector, enable);
    watchdog = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", `Start-Sleep -Seconds 180; ${enable}`],
      { detached: true, stdio: "ignore" },
    );
    restore = () =>
      requireCommandSync(
        ["powershell.exe", "-NoProfile", "-Command", restoration],
        { timeout: 60000, stdio: "inherit" },
      );
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
