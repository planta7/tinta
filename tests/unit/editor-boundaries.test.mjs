import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  edges,
  ownerPath,
  checkWorkspace,
  checkImport,
  inspectSource,
  checkRelativeImport,
} from "../../scripts/architecture.mjs";

describe("native editor capability boundaries", () => {
  for (const [owner, dependency] of [
    ["language-service", "@tinta/engine"],
    ["language-server", "node:worker_threads"],
    ["local-files", "node:fs/promises"],
    ["vscode", "vscode"],
    ["vscode", "@tinta/local-files"],
    ["vscode-webview", "@tinta/reader"],
    ["cli", "@tinta/local-files"],
  ])
    it(`permits ${owner} -> ${dependency}`, () => {
      expect(() => checkImport(owner, dependency)).not.toThrow();
    });

  for (const [owner, dependency] of [
    ["language-service", "node:fs"],
    ["language-service", "vscode"],
    ["language-server", "fs"],
    ["language-server", "node:net"],
    ["language-server", "node:child_process"],
    ["local-files", "node:child_process"],
    ["vscode", "node:fs"],
    ["vscode-webview", "node:crypto"],
    ["vscode-webview", "vscode"],
    ["vscode-webview", "react"],
    ["vscode-webview", "@tinta/local-files"],
    ["engine", "@tinta/local-files"],
    ["vscode", "vscode-languageclient"],
  ])
    it(`rejects ${owner} -> ${dependency}`, () => {
      expect(() => checkImport(owner, dependency)).toThrow();
    });

  for (const [owner, code] of [
    ["vscode-webview", 'fetch("file:///secret")'],
    ["vscode-webview", "localStorage.length"],
    ["language-server", "window.document"],
    ["language-service", "performance.now()"],
    ["language-service", "Date.now()"],
    ["language-service", "setInterval(work, 1)"],
    ["vscode", 'require("fs")'],
  ])
    it(`rejects ${owner} ambient authority: ${code}`, () => {
      expect(() => inspectSource(owner, code)).toThrow();
    });

  it("discovers native owners and checks their actual browser entries", () => {
    const root = mkdtempSync(join(tmpdir(), "tinta-boundaries-"));
    function owner(name) {
      const base = join(root, ownerPath(name));
      mkdirSync(join(base, "src"), { recursive: true });
      writeFileSync(
        join(base, "package.json"),
        JSON.stringify({ private: true }),
      );
      writeFileSync(join(base, "src/index.ts"), "export const value = 1;");
      return base;
    }
    try {
      for (const name of Object.keys(edges)) owner(name);
      owner("language-service");
      const native = owner("vscode");
      mkdirSync(join(native, "src/webview"));
      const browser = join(native, "src/webview/index.mjs");
      writeFileSync(browser, 'import "@tinta/reader";');
      expect(checkWorkspace(root)).toBe(11);
      writeFileSync(browser, 'import "node:fs";');
      expect(() => checkWorkspace(root)).toThrow("Host dependency");
      writeFileSync(browser, 'import "../index.js";');
      expect(() => checkWorkspace(root)).toThrow("Cross-boundary");
      writeFileSync(browser, 'import "@tinta/reader";');
      rmSync(join(root, ownerPath("engine"), "package.json"));
      expect(() => checkWorkspace(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps browser relative imports within the browser subtree", () => {
    const base = resolve("apps/vscode");
    const file = resolve(base, "src/webview/index.ts");
    expect(() =>
      checkRelativeImport(
        "vscode",
        base,
        resolve(base, "src/index.ts"),
        "./webview/index.js",
      ),
    ).toThrow();
    expect(() =>
      checkRelativeImport("vscode-webview", base, file, "./bridge.js"),
    ).not.toThrow();
    expect(() =>
      checkRelativeImport("vscode-webview", base, file, "../files.js"),
    ).toThrow();
    expect(() =>
      checkRelativeImport(
        "vscode",
        base,
        file,
        "../../../../packages/cli/src/files.js",
      ),
    ).toThrow();
  });
});
