import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const devApiTarget = (env.VITE_DEV_API_TARGET ?? "http://localhost:8787").trim();

  return {
    plugins: [react()],
    // Load .env.* from the repo root (so commands work from root).
    envDir: repoRoot,
    server: {
      proxy: {
        "/api": {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
