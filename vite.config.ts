import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "frontend"),
  base: "/static/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7110",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "src/collector/static"),
    emptyOutDir: false,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "app.js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((n) => n.endsWith(".css")) || assetInfo.name?.endsWith(".css")) {
            return "style.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
