import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@tinta/local-files": resolve("packages/local-files/dist/index.js"),
      vscode: resolve("tests/vscode/api-stub.mjs"),
      "vscode-languageclient/node": resolve("tests/vscode/client-stub.mjs"),
      "vscode-languageserver/node": resolve("tests/vscode/server-stub.mjs"),
    },
  },
  test: {
    include: [
      "tests/unit/language-server.test.mjs",
      "tests/unit/authoring.test.mjs",
      "tests/vscode/adapters.native.mjs",
      "tests/vscode/preview-controller.native.mjs",
      "tests/vscode/files.native.mjs",
      "tests/vscode/artifacts.native.mjs",
      "tests/unit/native-preview-source.test.mjs",
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/language-server/dist/**/*.js",
        "apps/vscode/dist/extension.js",
        "apps/vscode/dist/preview.js",
        "apps/vscode/dist/source.js",
        "apps/vscode/dist/files.js",
        "apps/vscode/dist/artifacts.js",
        "apps/vscode/dist/artifact-worker/operation.js",
      ],
      reportsDirectory: "coverage/vscode",
      reporter: ["text", "json-summary", "json"],
      thresholds: { statements: 85, functions: 85, lines: 85, branches: 80 },
    },
  },
});
