import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { join, posix, win32 } from "node:path";
import { isInsideDirectory } from "../../scripts/consumer-paths.mjs";

const fixtures = vi.hoisted(() => ({
  execute: vi.fn(),
  spawn: vi.fn(),
  append: vi.fn(),
  write: vi.fn(),
  exists: vi.fn(),
  interfaces: vi.fn(),
  downloadHash: "",
}));
vi.mock("../../scripts/commands.mjs", () => ({
  requireCommandSync: fixtures.execute,
}));
vi.mock("node:child_process", () => ({ spawn: fixtures.spawn }));
vi.mock("node:os", async (original) => ({
  ...(await original()),
  networkInterfaces: fixtures.interfaces,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original();
  return {
    ...actual,
    appendFileSync: fixtures.append,
    writeFileSync: fixtures.write,
    mkdirSync: vi.fn(),
    existsSync: fixtures.exists,
    readFileSync: (path, ...args) => {
      if (path === "toolchain/vscode-downloads.json") {
        const pins = JSON.parse(actual.readFileSync(path));
        for (const pin of Object.values(pins))
          pin.sha256hash = fixtures.downloadHash;
        return JSON.stringify(pins);
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalArgv = process.argv;
const originalUid = Object.getOwnPropertyDescriptor(process, "getuid");
const originalGid = Object.getOwnPropertyDescriptor(process, "getgid");
const bytes = Buffer.from("fixture desktop archive");

function platform(name) {
  Object.defineProperty(process, "platform", { value: name });
  Object.defineProperty(process, "arch", {
    value: name === "win32" ? "x64" : "arm64",
  });
  Object.defineProperty(process, "getuid", {
    value: () => 1001,
    configurable: true,
  });
  Object.defineProperty(process, "getgid", {
    value: () => 1001,
    configurable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixtures.downloadHash = createHash("sha256").update(bytes).digest("hex");
  fixtures.exists.mockReturnValue(true);
  fixtures.execute.mockImplementation((command) => ({
    stdout: command[0] === "powershell.exe" ? "[7,12]" : "Code\n",
  }));
  fixtures.spawn.mockReturnValue({ unref: vi.fn() });
  fixtures.interfaces.mockReturnValue({
    lo0: [{ internal: true }],
    en0: [{ internal: false }],
  });
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted");
  vi.stubEnv("RUNNER_TEMP", "/fixture temp");
  vi.stubEnv("TINTA_GLOBAL_MODULES", "/fixture tools");
  vi.stubEnv("GITHUB_ENV", "/fixture environment");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes,
    }),
  );
  process.argv = ["node", "candidate-tools.mjs", "--desktop"];
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "arch", { value: originalArch });
  process.argv = originalArgv;
  for (const [name, descriptor] of [
    ["getuid", originalUid],
    ["getgid", originalGid],
  ]) {
    if (descriptor) Object.defineProperty(process, name, descriptor);
    else delete process[name];
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("consumer containment on native path formats", () => {
  it.each([
    [win32, "D:\\repo", "C:\\Temp\\consumer", false],
    [win32, "D:\\repo", "D:\\Temp\\consumer", false],
    [win32, "D:\\repo", "D:\\repo\\build", true],
    [win32, "D:\\repo", "D:\\repository", false],
    [win32, "D:\\repo", "D:\\", false],
    [win32, "D:\\repo", "d:\\REPO\\child", true],
    [posix, "/repo", "/tmp/consumer", false],
    [posix, "/repo", "/repo/build", true],
    [posix, "/repo", "/repository", false],
    [posix, "/repo", "/repo", true],
  ])(
    "checks containment without assuming a shared drive",
    (paths, root, target, expected) => {
      expect(isInsideDirectory(root, target, paths)).toBe(expected);
    },
  );
});

describe("pinned desktop installation fixtures", () => {
  it.each(["darwin", "linux", "win32"])(
    "prepares %s without running host commands",
    async (name) => {
      platform(name);
      if (name === "win32") {
        // Paths inspected in the checksum-pinned upstream Windows archive.
        const present = new Set([
          "/fixture tools/pnpm/bin/pnpm.cjs",
          "/fixture tools/npm/bin/npm-cli.js",
          "/fixture temp/tinta-desktop/Code.exe",
          "/fixture temp/tinta-desktop/2a59476c9b/resources/app/out/cli.js",
          "/fixture temp/tinta-desktop/2a59476c9b/resources/app/product.json",
          "/fixture temp/tinta-desktop/2a59476c9b/resources/app/package.json",
        ]);
        fixtures.exists.mockImplementation((path) =>
          present.has(path.replaceAll("\\", "/")),
        );
      }
      await import("../../scripts/candidate-tools.mjs");
      const environment = fixtures.append.mock.calls
        .map((call) => call[1])
        .join("")
        .replaceAll("\\", "/");
      expect(environment).toContain("TINTA_VSCODE_EXECUTABLE=");
      if (name === "darwin") {
        expect(environment).toContain("Contents/MacOS/Code\n");
        expect(environment).not.toContain("MacOS/Electron");
      } else if (name === "linux") {
        const commands = fixtures.execute.mock.calls.map((call) => call[0]);
        expect(commands.slice(-2)).toEqual([
          [
            "sudo",
            "chown",
            "root:root",
            join(
              "/fixture temp",
              "tinta-desktop/VSCode-linux-arm64/chrome-sandbox",
            ),
          ],
          [
            "sudo",
            "chmod",
            "4755",
            join(
              "/fixture temp",
              "tinta-desktop/VSCode-linux-arm64/chrome-sandbox",
            ),
          ],
        ]);
      } else {
        expect(environment).toContain("Code.exe\n");
        expect(environment).toContain("2a59476c9b/resources/app/out/cli.js\n");
      }
    },
  );
  it("refuses changed download bytes before extraction or privileges", async () => {
    platform("linux");
    fixtures.downloadHash = "0".repeat(64);
    await expect(import("../../scripts/candidate-tools.mjs")).rejects.toThrow(
      "hash mismatch",
    );
    expect(fixtures.execute).not.toHaveBeenCalled();
    expect(fixtures.append).not.toHaveBeenCalled();
  });
  it("refuses elevated sandbox setup outside a disposable runner", async () => {
    platform("linux");
    vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted");
    await expect(import("../../scripts/candidate-tools.mjs")).rejects.toThrow();
    expect(
      fixtures.execute.mock.calls.some(([command]) => command[0] === "sudo"),
    ).toBe(false);
  });
  it("rejects an executable name escaping the verified application", async () => {
    platform("darwin");
    fixtures.execute.mockReturnValue({ stdout: "../../untrusted\n" });
    await expect(import("../../scripts/candidate-tools.mjs")).rejects.toThrow();
    expect(fixtures.append).not.toHaveBeenCalled();
  });
});

describe("offline adapter command fixtures", () => {
  it("isolates Linux descendants while retaining the unprivileged identity", async () => {
    platform("linux");
    const { offlineInstalled } =
      await import("../../scripts/candidate-offline.mjs");
    offlineInstalled(["/pinned node", "test.mjs"]);
    const [command, options] = fixtures.execute.mock.calls[0];
    expect(command.slice(0, 6)).toEqual([
      "sudo",
      "--preserve-env",
      "unshare",
      "--net",
      "--",
      "bash",
    ]);
    expect(command).toContain(String(process.getuid()));
    expect(command.slice(-2)).toEqual(["/pinned node", "test.mjs"]);
    expect(options.env.TINTA_CANDIDATE_OFFLINE).toBe("network-namespace");
  });
  it.each(["darwin", "win32"])(
    "restores %s adapters after a failed test",
    async (name) => {
      platform(name);
      fixtures.execute.mockImplementation((command) => {
        if (command[0] === "/pinned node")
          throw new Error("fixture test failure");
        return { stdout: "[7,12]" };
      });
      const { offlineInstalled } =
        await import("../../scripts/candidate-offline.mjs");
      expect(() => offlineInstalled(["/pinned node", "test.mjs"])).toThrow(
        "fixture test failure",
      );
      expect(fixtures.spawn).toHaveBeenCalledOnce();
      expect(fixtures.spawn.mock.results[0].value.unref).toHaveBeenCalledOnce();
      const commands = fixtures.execute.mock.calls.map(([command]) => command);
      if (name === "darwin") {
        expect(commands.at(-1)).toEqual(["sudo", "ifconfig", "en0", "up"]);
        expect(fixtures.write.mock.calls[0][1]).toContain(
          "sleep 180\n/sbin/ifconfig en0 up",
        );
      } else {
        expect(commands.at(-1).at(-1)).toContain("Enable-NetAdapter");
        expect(commands.at(-1).at(-1)).toContain("@(7,12)");
        expect(commands.at(-1).at(-1)).toContain("Resolve-DnsName");
        expect(commands.at(-1).at(-1)).toContain("Get-NetIPConfiguration");
        expect(fixtures.execute.mock.calls.at(-1)[1].timeout).toBe(60000);
      }
    },
  );

  it("checks the runner endpoints after restoring Windows adapters, without exposing URL credentials", async () => {
    platform("win32");
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.example");
    vi.stubEnv("GITHUB_API_URL", "https://github.example/api/v3");
    vi.stubEnv(
      "ACTIONS_RESULTS_URL",
      "https://artifact.example/path?token=private-value",
    );
    const { offlineInstalled } =
      await import("../../scripts/candidate-offline.mjs");
    offlineInstalled(["/pinned node", "test.mjs"]);
    const commands = fixtures.execute.mock.calls.map(([command]) => command);
    expect(commands[2]).toEqual(["/pinned node", "test.mjs"]);
    const restoration = commands[3].at(-1);
    expect(restoration).toContain("@('github.example','artifact.example')");
    expect(restoration).not.toContain("private-value");
    expect(restoration.indexOf("Enable-NetAdapter")).toBeLessThan(
      restoration.indexOf("Clear-DnsClientCache"),
    );
    expect(restoration.indexOf("Clear-DnsClientCache")).toBeLessThan(
      restoration.indexOf("Resolve-DnsName"),
    );
    expect(restoration).toContain("AddSeconds(45)");
    expect(restoration).toContain('throw "Hosted network restoration exceeded');
  });

  it("fails if Windows network restoration fails after a successful offline test", async () => {
    platform("win32");
    fixtures.execute.mockImplementation((command) => {
      if (command.at(-1).includes("Resolve-DnsName"))
        throw new Error("Hosted network restoration exceeded 45 seconds");
      return { stdout: "[7,12]" };
    });
    const { offlineInstalled } =
      await import("../../scripts/candidate-offline.mjs");
    expect(() => offlineInstalled(["/pinned node", "test.mjs"])).toThrow(
      "Hosted network restoration exceeded",
    );
    expect(
      fixtures.execute.mock.calls.some(
        ([command]) => command[0] === "/pinned node",
      ),
    ).toBe(true);
  });
});
