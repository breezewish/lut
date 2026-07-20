import { expect, type Page, test } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.RAW_PERF === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const samples = Number(process.env.RAW_PERF_SAMPLES ?? "5");

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
  let exportRun:
    | { exportWallMs: number; worker: unknown; blob: unknown }
    | undefined;

  await page.goto("/");
  await page.waitForFunction(() => crossOriginIsolated);
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
          () => performance.getEntriesByName("lutify:preview-worker").length,
        ),
      )
      .toBe(1);
    const previewWallMs = performance.now() - previewStartedAt;
    const preview = await latestMarkDetail(page, "lutify:preview-worker");
    const initial = await initialPreviewBoundaries(page);

    runs.push({ previewWallMs, initial, preview });
    if (index === samples - 1) {
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
      await page
        .getByRole("button", { name: "Export selected as TIFF" })
        .click();
      const download = await Promise.race([
        downloadPromise,
        exportErrorPromise,
      ]);
      await download.path();
      exportRun = {
        exportWallMs: performance.now() - exportStartedAt,
        worker: await latestMarkDetail(page, "lutify:export-worker"),
        blob: await latestMarkDetail(page, "lutify:blob"),
      };
    }
    await page
      .getByRole("button", { name: `Remove ${fixture.split("/").at(-1)}` })
      .click();
    await expect(page.getByText("Start with a camera RAW")).toBeVisible();
  }

  const report = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 3,
        fixture,
        fixtureBytes: fixtureStat.size,
        samples,
        colorBackend: "webgpu",
        adapterInfo,
        coldRun: runs[0],
        warmRuns: runs.slice(1),
        exportRun,
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

  if (runs[0].initial.thumbnailMs !== null) {
    expect(runs[0].initial.thumbnailMs).toBeLessThan(300);
  }
  expect(runs[0].initial.processedPreviewMs).toBeLessThan(1_200);
  expect(runs[0].initial.settledPreviewMs).toBeLessThan(1_500);
  expect(
    percentile(
      runs.slice(1).map(({ initial }) => initial.processedPreviewMs),
      0.95,
    ),
  ).toBeLessThan(600);
  expect(
    percentile(
      runs.slice(1).map(({ initial }) => initial.settledPreviewMs),
      0.95,
    ),
  ).toBeLessThan(800);
});

async function latestMarkDetail(page: Page, name: string) {
  return page.evaluate((markName) => {
    const mark = performance
      .getEntriesByName(markName)
      .at(-1) as PerformanceMark;
    return mark.detail;
  }, name);
}

async function initialPreviewBoundaries(page: Page) {
  return page.evaluate(() => {
    const selectedAt = performance.getEntriesByName("lutify:file-selected")[0]
      .startTime;
    const thumbnail = performance.getEntriesByName("lutify:thumbnail")[0];
    const fileRead = performance.getEntriesByName(
      "lutify:file-read",
    )[0] as PerformanceMark;
    const draws = performance
      .getEntriesByName("lutify:canvas-draw")
      .map((entry) => ({
        at: entry.startTime,
        ...(entry as PerformanceMark).detail,
      }));
    return {
      fileReadMs: fileRead.detail.durationMs as number,
      thumbnailMs: thumbnail ? thumbnail.startTime - selectedAt : null,
      processedPreviewMs:
        draws.find(({ width }) => width === 384)!.at - selectedAt,
      settledPreviewMs:
        draws.find(({ width }) => width === 1_024)!.at - selectedAt,
      canvasDraws: draws,
    };
  });
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}
