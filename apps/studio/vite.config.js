import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "studio-host-policy",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler() {
          const generated = readFileSync(
            new URL("./dist/runtime/previewHtml.js", import.meta.url),
            "utf8",
          );
          const preview = JSON.parse(
            generated
              .slice(generated.indexOf("=") + 1)
              .trim()
              .replace(/;$/, ""),
          );
          const previewHash = preview.match(/script-src ('sha256-[^']+')/)?.[1];
          if (!previewHash)
            throw new Error("Missing trusted preview script hash.");
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: `default-src 'none'; script-src 'self' ${previewHash}; style-src 'self' 'unsafe-inline'; img-src data: blob:; worker-src blob:; frame-src 'self' blob:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
  ],
  base: "./",
  resolve: {
    alias: {
      "./studio-runtime.js": new URL(
        "./dist/studio-runtime.js",
        import.meta.url,
      ).pathname,
    },
  },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: {
    // The portable file-origin artifact is assembled separately.
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            { name: "compiler-runtime", test: /runtime\/workerCode\.js$/ },
            { name: "preview-runtime", test: /runtime\/previewHtml\.js$/ },
            {
              name: "export-runtime",
              test: /artifacts\/dist\/runtime-data\.js$/,
            },
            {
              name: "editor",
              test: /node_modules\/(?:@codemirror|@lezer|style-mod|w3c-keyname|crelt)\//,
              priority: 20,
              maxSize: 1_000_000,
            },
            {
              name: "react",
              test: /node_modules\/(?:react|react-dom|scheduler)\//,
              priority: 20,
            },
            { name: "vendor", test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
    sourcemap: false,
    outDir: "../../build/studio",
    emptyOutDir: true,
  },
});
