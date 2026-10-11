import { it, expect } from "vitest";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { npmRunner, npmAdapter } from "../../scripts/publication-npm.mjs";
import { httpTransport } from "../../scripts/publication-transport.mjs";
import { verifyPublishingTool } from "../../scripts/publication-tools.mjs";
import { fileRecord } from "../../scripts/release-candidate.mjs";

it("publishes, downloads, installs and promotes exact fixture bytes only on loopback", async () => {
  expect(
    process.env.TINTA_PUBLICATION_NPM,
    "Provide the checksum-verified npm CLI",
  ).toBeTruthy();
  verifyPublishingTool(
    dirname(dirname(process.env.TINTA_PUBLICATION_NPM)),
    JSON.parse(readFileSync("toolchain/publication.json")).npm,
    JSON.parse(readFileSync("toolchain/publication-npm-lock.json")),
  );
  const directory = mkdtempSync(join(tmpdir(), "publication-loopback-"));
  const server = fork(new URL("./registry.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    const [{ origin }] = await Promise.race([
      once(server, "message"),
      once(server, "exit").then(() => {
        throw new Error("Loopback fixture could not start");
      }),
    ]);
    expect(new URL(origin).hostname).toBe("127.0.0.1");
    mkdirSync(join(directory, "package"));
    writeFileSync(
      join(directory, "package/package.json"),
      JSON.stringify({
        name: "@fixture/publication",
        version: "1.0.0",
        private: false,
        publishConfig: { access: "public", tag: "next" },
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFileSync(
      join(directory, "package/index.js"),
      "export const fixture = 42;\n",
    );
    const archivePath = join(directory, "fixture.tgz");
    const tar = spawnSync("tar", [
      "--format=ustar",
      "-czf",
      archivePath,
      "-C",
      directory,
      "package/package.json",
      "package/index.js",
    ]);
    expect(tar.status).toBe(0);
    const archive = fileRecord("fixture.tgz", readFileSync(archivePath));
    const target = {
      kind: "npm",
      name: "@fixture/publication",
      version: "1.0.0",
      channel: "latest",
      dependencies: [],
      externalDependencies: {},
      archive,
    };
    const runner = npmRunner(process.env.TINTA_PUBLICATION_NPM);
    const run = (args, _authenticated, cwd) =>
      runner.run(
        [...args, `--//${new URL(origin).host}/:_authToken=loopback-fixture`],
        false,
        cwd,
      );
    const adapter = npmAdapter({
      directory,
      registry: origin,
      runner: { run },
      request: httpTransport(),
    });
    const plan = { candidate: archive.sha256, targets: [target] };
    await adapter.preflight(plan);
    const operation = adapter.upload(target, plan);
    expect(await operation.read()).toBeNull();
    await operation.write();
    expect((await operation.verify(await operation.read())).sha256).toBe(
      archive.sha256,
    );
    expect(await adapter.channel(target)).toBeNull();
    await adapter.verifyInstall([target]);
    const promotion = adapter.promote(target, null);
    await promotion.write();
    expect(await promotion.read()).toBe("1.0.0");
    await promotion.verify(await promotion.read());
    const stats = await (await fetch(`${origin}/stats`)).json();
    expect(stats.uploads).toBe(1);
    expect(stats.promotions).toBe(1);
    expect(fileRecord("fixture.tgz", readFileSync(archivePath))).toEqual(
      archive,
    );
  } finally {
    if (server.connected) server.disconnect();
    if (server.exitCode === null) await once(server, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
