import { defineConfig } from "vitest/config";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  define: {
    TEST_ENTRIES_ENABLED: JSON.stringify(
      process.env.VITE_ENABLE_TEST_ENTRIES === "1",
    ),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.VITE_HTTPS === "1" ? [basicSsl()] : []),
  ],
  root: "web",
  publicDir: "public",
  server: {
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    css: true,
  },
});
