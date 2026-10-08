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
    sourcemap: false,
    outDir: "../../build/dev-studio",
    emptyOutDir: true,
  },
});
