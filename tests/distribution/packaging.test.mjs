import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { join, dirname } from "node:path";
import {
  loadReleaseConfig,
  selectedTargets,
} from "../../scripts/release-contract.mjs";
import {
  inspectNpm,
  packageOrder,
  stagingManifest,
} from "../../scripts/distribution-npm.mjs";
import {
  digest,
  inspectEntries,
  readTarball,
  readZip,
  safePath,
  zipEntries,
} from "../../scripts/distribution-archive.mjs";
import { inspectPackage } from "../../scripts/vscode-package.mjs";
import { versionModule } from "../../scripts/implementation-version.mjs";

const config = loadReleaseConfig();
const inventory = JSON.parse(
  await readFile("build/distribution/inventory.json", "utf8"),
);
const json = (bytes) => JSON.parse(Buffer.from(bytes).toString());
const selected = selectedTargets(config);
const has = (id) => selected.some((target) => target.id === id);
const target = config.packages.find((item) => item.id === "syntax");
const syntaxReport = inventory.targets.find((item) => item.id === "syntax");
const syntax = syntaxReport
  ? readTarball(await readFile(`build/distribution/${syntaxReport.archive}`))
  : undefined;
const syntaxManifest = syntax && json(syntax["package.json"]);
const syntaxFiles = syntaxReport?.files.map((file) => file.path);

async function extracted(ids, operation) {
  const directory = await mkdtemp(join(tmpdir(), "tinta-payload-"));
  try {
    for (const id of ids) {
      const report = inventory.targets.find((item) => item.id === id);
      const entries = readTarball(
        await readFile(`build/distribution/${report.archive}`),
      );
      for (const [path, bytes] of Object.entries(entries)) {
        const output = join(directory, "node_modules", "@tinta-lang", id, path);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, bytes);
      }
    }
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("portable distribution payloads", () => {
  it("has the complete declared delivery inventory", () => {
    expect(inventory.targets.map((item) => item.id).sort()).toEqual(
      selected.map((item) => item.id).sort(),
    );
    expect(inventory.component).toBe(process.env.TINTA_COMPONENT);
    expect(inventory.targets).toHaveLength(
      { language: 12, studio: 4, vscode: 2 }[process.env.TINTA_COMPONENT] ?? 16,
    );
    expect(inventory.versions).toEqual(config.versions);
  });

  it.each(config.packages.filter((target) => has(target.id)))(
    "checks $id entry points, dependencies and packed bytes",
    async (target) => {
      const report = inventory.targets.find((item) => item.id === target.id);
      const bytes = await readFile(`build/distribution/${report.archive}`);
      expect(digest(bytes)).toBe(report.sha256);
      const entries = readTarball(bytes);
      const source = json(await readFile(`${target.source}/package.json`));
      const readme = await readFile(`${target.source}/README.md`);
      expect(entries["README.md"]).toEqual(readme);
      expect(source.description).toMatch(/\S/);
      expect(source.keywords.length).toBeGreaterThan(0);
      expect(source.homepage).toBe(
        `https://github.com/planta7/tinta/blob/main/${target.source}/README.md`,
      );
      const published = json(entries["package.json"]);
      expect(published.description).toBe(source.description);
      expect(published.keywords).toEqual(source.keywords);
      expect(published.homepage).toBe(source.homepage);
      const manifest = stagingManifest(
        config,
        target,
        source,
        Object.keys(entries).filter((name) => name !== "package.json"),
      );
      expect(
        inspectNpm(
          entries,
          config,
          target,
          manifest,
          report.files.map((file) => file.path),
        ),
      ).toEqual(report.files);
      expect(source.private).toBe(true);
      expect(source.version).toBe("0.0.0");
    },
  );

  it.each(config.artifacts.filter((target) => has(target.id)))(
    "checks $id archive hashes and exact contents",
    async (target) => {
      const report = inventory.targets.find((item) => item.id === target.id);
      const bytes = await readFile(`build/distribution/${report.archive}`);
      expect(digest(bytes)).toBe(report.sha256);
      if (target.id === "vscode") {
        expect(inspectPackage(bytes, { release: true }).files).toEqual(
          report.files,
        );
      } else {
        const entries = readZip(bytes);
        expect(
          inspectEntries(
            entries,
            report.files.map((file) => file.path),
            { source: target.id === "source" },
          ),
        ).toEqual(report.files);
        expect(entries.LICENSE.length).toBeGreaterThan(100);
        expect(entries["THIRD_PARTY_NOTICES.txt"].length).toBeGreaterThan(100);
        expect(Buffer.from(zipEntries(entries))).toEqual(bytes);
      }
    },
  );

  it("keeps the complete internal graph in dependency order", () => {
    const order = packageOrder(config);
    expect(order).toHaveLength(10);
    for (const target of config.packages)
      for (const dependency of target.dependencies)
        expect(order.indexOf(dependency)).toBeLessThan(
          order.indexOf(target.id),
        );
    expect(order.indexOf("local-files")).toBeLessThan(order.indexOf("cli"));
  });

  it("rejects missing targets and cyclic graphs", () => {
    const missing = structuredClone(config);
    missing.packages = missing.packages.filter(
      (item) => item.id !== "local-files",
    );
    expect(() => packageOrder(missing)).toThrow(/Missing target/);
    const cyclic = structuredClone(config);
    cyclic.packages[0].dependencies.push("syntax");
    expect(() => packageOrder(cyclic)).toThrow(/cycle/);
  });

  if (has("syntax")) {
    it.each([
      "dist/index.js",
      "dist/index.d.ts",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ])("rejects omitted %s", (path) => {
      const entries = { ...syntax };
      delete entries[path];
      expect(() =>
        inspectNpm(entries, config, target, syntaxManifest, syntaxFiles),
      ).toThrow(/entries/);
    });

    it.each([".env", ".local/plan.md", "dist/unexpected.js"])(
      "rejects extra %s",
      (path) => {
        expect(() =>
          inspectNpm(
            { ...syntax, [path]: Buffer.from("extra") },
            config,
            target,
            syntaxManifest,
            syntaxFiles,
          ),
        ).toThrow(/entries/);
      },
    );

    it.each(["workspace:*", "file:../types", "link:../types", "0.2.0-dev.0"])(
      "rejects inconsistent internal version %s",
      (version) => {
        const manifest = structuredClone(syntaxManifest);
        manifest.dependencies["@tinta-lang/types"] = version;
        const entries = {
          ...syntax,
          "package.json": Buffer.from(JSON.stringify(manifest)),
        };
        expect(() =>
          inspectNpm(entries, config, target, syntaxManifest, syntaxFiles),
        ).toThrow(/manifest/);
      },
    );

    it.each([
      "/Users/example/private",
      ".local/automation/plan",
      "-----BEGIN PRIVATE KEY-----",
      "//# sourceMappingURL=hidden.map",
    ])("rejects private content %s", (content) => {
      const entries = { ...syntax, "dist/index.js": Buffer.from(content) };
      expect(() =>
        inspectNpm(entries, config, target, syntaxManifest, syntaxFiles),
      ).toThrow(/Private or development/);
    });
  }
  it.each([
    "../escape",
    "/absolute",
    "a/../b",
    "a\\b",
    "a//b",
    "agents.md",
    ".env.local",
  ])("rejects unsafe path %s", (path) => {
    expect(() => safePath(path)).toThrow(/Unsafe/);
  });

  if (has("syntax")) {
    it("rejects an unresolved relative dependency even when its containing file exists", () => {
      const entries = {
        ...syntax,
        "dist/index.js": Buffer.from('export * from "./missing.js";'),
      };
      expect(() =>
        inspectNpm(entries, config, target, syntaxManifest, syntaxFiles),
      ).toThrow(/Missing relative dependency/);
    });

    it("rejects unapproved external imports", () => {
      const entries = {
        ...syntax,
        "dist/index.js": Buffer.from('import "unapproved";'),
      };
      expect(() =>
        inspectNpm(entries, config, target, syntaxManifest, syntaxFiles),
      ).toThrow(/Undeclared dependency/);
    });
  }
  it("does not exempt private content in source archives", () => {
    const path = "README.md";
    const entries = { [path]: Buffer.from("/" + "Users/example/secret") };
    expect(() => inspectEntries(entries, [path], { source: true })).toThrow(
      /Private or development/,
    );
  });

  it("rejects changed synthetic fixtures rather than exempting entire test files", () => {
    const path = "tests/unit/vscode-package.test.mjs";
    const entries = { [path]: Buffer.from("/" + "Users/example/secret") };
    expect(() => inspectEntries(entries, [path], { source: true })).toThrow(
      /Private or development/,
    );
  });

  it("rejects archive case collisions and prototype paths", () => {
    expect(() => safePath("package/__proto__")).toThrow(/Unsafe/);
    const entries = { License: Buffer.from("a"), LICENSE: Buffer.from("b") };
    expect(() => inspectEntries(entries, Object.keys(entries))).toThrow(
      /entries/,
    );
  });

  if (has("syntax")) {
    it("retains patched parser provenance, source and licenses", () => {
      const provenance = json(syntax["parser-provenance.json"]);
      expect(provenance.patchSha256).toBe(
        digest(syntax["patches/micromark.patch"]),
      );
      expect(
        provenance.packages.filter((item) => item.name === "micromark"),
      ).toHaveLength(1);
      for (const source of provenance.sources)
        expect(digest(syntax[source.path])).toBe(source.sha256);
      expect(
        Buffer.from(
          syntax["vendor/micromark/lib/create-tokenizer.js"],
        ).toString(),
      ).toContain("observeTokenizer?.('transition', point.offset)");
      expect(Buffer.from(syntax["dist/index.js"]).toString()).not.toMatch(
        /from ["'](?:micromark|mdast-util)/,
      );
    });

    it("enforces ordinary Markdown budget and recovery in the staged parser bundle", async () => {
      await extracted(["types", "syntax"], async (directory) => {
        const { parse, parseRecovering } = await import(
          pathToFileURL(
            join(directory, "node_modules/@tinta-lang/syntax/dist/index.js"),
          ).href
        );
        const result = parse(
          {
            text: "ordinary ".repeat(100),
            profile: "markdown",
            uri: "tinta:budget",
          },
          { limits: { compileOperations: 100 } },
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0].details).toEqual({
          limitName: "compileOperations",
          observed: 101,
          maximum: 100,
        });
        const deep = parse({
          text: "> ".repeat(1000) + "text",
          profile: "markdown",
          uri: "tinta:depth",
        });
        expect(deep.ok).toBe(false);
        expect(deep.diagnostics[0].code).toBe("E_LIMIT");
        const recovered = parseRecovering({
          text: "@let =\n\n# After",
          profile: "tinta",
          uri: "tinta:recovery",
        });
        expect(recovered.diagnostics.length).toBeGreaterThan(0);
        expect(
          recovered.value.tree.children.some((node) => node.kind === "heading"),
        ).toBe(true);
      });
    });
  }
  it("uses the same generated version for legitimate changed versions", async () => {
    for (const version of ["0.1.0-dev.0", "0.2.0-dev.1", "1.0.0"]) {
      const module = await import(
        "data:text/javascript," + encodeURIComponent(versionModule(version))
      );
      expect(module.implementationVersion).toBe(version);
    }
    expect(() => versionModule('";process.exit()')).toThrow(/version/);
  });

  if (has("language-server"))
    it("runs the packaged IPC launcher and its sibling worker", async () => {
      await extracted(["language-server"], async (directory) => {
        const child = fork(
          join(
            directory,
            "node_modules/@tinta-lang/language-server/dist/server.mjs",
          ),
          [],
          {
            cwd: directory,
            execArgv: [],
            env: { ...process.env, NODE_PATH: "" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        const watchdog = setTimeout(() => child.kill(), 10000);
        let errors = "";
        child.stderr.on("data", (bytes) => {
          errors += bytes;
        });
        try {
          const response = new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("exit", (code) =>
              reject(new Error(`IPC exited: ${code}: ${errors}`)),
            );
            child.on("message", (message) => {
              if (message.id === 1) {
                expect(message.result.capabilities.positionEncoding).toBe(
                  "utf-16",
                );
                child.send({
                  jsonrpc: "2.0",
                  method: "initialized",
                  params: {},
                });
                child.send({
                  jsonrpc: "2.0",
                  method: "textDocument/didOpen",
                  params: {
                    textDocument: {
                      uri: "file:///ipc.tinta",
                      languageId: "tinta",
                      version: 1,
                      text: "@let x = 1\n\n{{ x }}",
                    },
                  },
                });
              }
              if (message.method === "tinta/status") resolve(message.params);
            });
          });
          child.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { processId: process.pid, capabilities: {}, rootUri: null },
          });
          expect(await response).toMatchObject({
            source: "valid",
            fidelity: "unverified",
            assets: "not-checked",
          });
        } finally {
          clearTimeout(watchdog);
          child.kill();
        }
      });
    });
});
