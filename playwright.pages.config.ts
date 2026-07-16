import { defineConfig, devices } from "@playwright/test";

const basePath = process.env.VITE_BASE_PATH ?? "/lut/";

export default defineConfig({
  testDir: "web/pages-e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:42733${basePath}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 42733 --strictPort",
    url: `http://127.0.0.1:42733${basePath}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
