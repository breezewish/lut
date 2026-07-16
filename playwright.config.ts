import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "https://127.0.0.1:42732",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "webkit",
      testMatch: "browser-smoke.spec.ts",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "firefox",
      testMatch: "browser-smoke.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "npx vite preview --host 0.0.0.0 --port 42731 --strictPort",
      url: "http://127.0.0.1:42731",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        "VITE_HTTPS=1 npx vite preview --host 127.0.0.1 --port 42732 --strictPort",
      url: "https://127.0.0.1:42732",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
