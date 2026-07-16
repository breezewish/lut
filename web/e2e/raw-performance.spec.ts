import { expect, type Page, test } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.RAW_PERF === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const samples = Number(process.env.RAW_PERF_SAMPLES ?? "5");
const requestedBackend = process.env.RAW_PERF_BACKEND;
const colorBackend =
  requestedBackend === "webgpu" || requestedBackend === "onnx"
    ? requestedBackend
    : "cpu";
const validateGpu = process.env.RAW_PERF_VALIDATE_GPU === "1";

test("records phased production Worker performance", async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set RAW_PERF=1 to run the formal performance benchmark.",
  );
  test.setTimeout(10 * 60_000);
  const fixtureStat = await stat(fixture);
  const runs = [];
  if (process.env.RAW_PERF_BROWSER_LOGS === "1") {
    page.on("console", (message) =>
      console.log(`[browser:${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) => console.log(`[browser:error] ${error}`));
  }

  await page.goto(
    `/?colorBackend=${colorBackend}${validateGpu ? "&validateGpu=1" : ""}`,
  );
  const adapterInfo = await page.evaluate(async () => {
    if (!("gpu" in navigator)) return undefined;
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    return adapter
      ? {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
          isFallbackAdapter: adapter.info.isFallbackAdapter,
        }
      : undefined;
  });
  for (let index = 0; index < samples; index += 1) {
    await page.evaluate(() => performance.clearMarks());
    const previewStartedAt = performance.now();
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByLabel("Base preview")).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance.getEntriesByName("raw-alchemy:preview-worker").length,
        ),
      )
      .toBe(1);
    const previewWallMs = performance.now() - previewStartedAt;
    const preview = await latestMarkDetail(page, "raw-alchemy:preview-worker");

    const exportStartedAt = performance.now();
    const downloadPromise = page.waitForEvent("download");
    const exportErrorPromise = page
      .getByRole("alert")
      .waitFor({ state: "visible", timeout: 10 * 60_000 })
      .then(async () => {
        throw new Error(
          `Browser export failed: ${await page.getByRole("alert").textContent()}`,
        );
      });
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await Promise.race([downloadPromise, exportErrorPromise]);
    await download.path();
    const exportWallMs = performance.now() - exportStartedAt;
    const worker = await latestMarkDetail(page, "raw-alchemy:export-worker");
    const blob = await latestMarkDetail(page, "raw-alchemy:blob");
    runs.push({ previewWallMs, preview, exportWallMs, worker, blob });
    await page
      .getByRole("button", { name: `Remove ${fixture.split("/").at(-1)}` })
      .click();
    await expect(page.getByText("Start with a camera RAW")).toBeVisible();
  }

  const report = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture,
        fixtureBytes: fixtureStat.size,
        samples,
        colorBackend,
        validateGpu,
        adapterInfo,
        coldRun: runs[0],
        warmRuns: runs.slice(1),
      },
      null,
      2,
    ),
  );
  const reportPath = testInfo.outputPath("raw-performance.json");
  await writeFile(reportPath, report);
  await testInfo.attach("raw-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });
});

async function latestMarkDetail(page: Page, name: string) {
  return page.evaluate((markName) => {
    const mark = performance
      .getEntriesByName(markName)
      .at(-1) as PerformanceMark;
    return mark.detail;
  }, name);
}
