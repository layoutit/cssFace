import { resolve } from "node:path";

import { defineConfig } from "vite";

const repoRoot = import.meta.dirname;

export default defineConfig({
  root: resolve(repoRoot, "src/adapters/facesjs/preview"),
  publicDir: resolve(repoRoot, "public"),
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir: resolve(repoRoot, "dist"),
    emptyOutDir: true,
  },
});
