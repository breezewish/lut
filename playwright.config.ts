import { defineConfig, devices } from "@playwright/test";

const httpPort = Number(process.env.PLAYWRIGHT_HTTP_PORT ?? "42731");
const httpsPort = httpPort + 1;
const hardwareWebGpuArgs =
  process.env.WEBGPU_HARDWARE === "1"
    ? [
        "--enable-gpu",
        "--use-angle=vulkan",
        "--enable-features=Vulkan",
        "--disable-vulkan-surface",
        "--enable-unsafe-webgpu",
      ]
    : [];

export default defineConfig({
  testDir: "web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `https://127.0.0.1:${httpsPort}`,
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
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: hardwareWebGpuArgs },
      },
    },
  ],
  webServer: [
    {
      command: `npx vite preview --host 0.0.0.0 --port ${httpPort} --strictPort`,
      url: `http://127.0.0.1:${httpPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `VITE_HTTPS=1 npx vite preview --host 127.0.0.1 --port ${httpsPort} --strictPort`,
      url: `https://127.0.0.1:${httpsPort}`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
