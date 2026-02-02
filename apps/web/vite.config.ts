import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Load .env.* from the repo root (so commands work from root).
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
});
