import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sanitizer = fileURLToPath(import.meta.resolve("dompurify"));

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: [{
      find: "./dompurify/dompurify.js",
      replacement: sanitizer,
    }],
  },
  plugins: [{
    name: "verify-monaco-sanitizer",
    generateBundle() {
      const modules = [...this.getModuleIds()];
      if (modules.some(id => /monaco-editor\/esm\/vs\/base\/browser\/dompurify\/dompurify\.js(?:$|\?)/.test(id))
        || (modules.some(id => id.endsWith("/vs/base/browser/domSanitize.js")) && !modules.includes(sanitizer))) {
        this.error("The Monaco bundle must use the pinned DOMPurify module.");
      }
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/dist/**", "**/dist-e2e/**", "**/test-results/**"] },
  },
  build: { target: "es2022", outDir: process.env.VITE_IRON_E2E === "1" ? "dist-e2e" : "dist" },
  worker: { format: "es" },
});
