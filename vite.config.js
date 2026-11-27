import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sanitizer = fileURLToPath(import.meta.resolve("dompurify"));
const acceptance = process.env.VITE_IRON_E2E === "1";

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: [{
      find: "./dompurify/dompurify.js",
      replacement: sanitizer,
    }],
  },
  plugins: [...(acceptance ? [{
    name: "acceptance-startup-errors",
    apply: "build",
    buildStart() {
      this.emitFile({ type: "asset", fileName: "acceptance-errors.js", source: readFileSync(new URL("./tests/native/acceptance-errors.js", import.meta.url)) });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: "/acceptance-errors.js" }, injectTo: "head-prepend" }];
    },
  }] : []), {
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
  build: { target: "es2022", outDir: acceptance ? "dist-e2e" : "dist" },
  worker: { format: "es" },
});
