import { URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
    // Only the loopback development build uses chunks. The production
    // file-origin artifact is assembled separately by scripts/studio.mjs.
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
    outDir: "../../build/dev-studio",
    emptyOutDir: true,
  },
});
