import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://127.0.0.1:4747", changeOrigin: true } },
  },
});
