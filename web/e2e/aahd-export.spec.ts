import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

const fixture = resolve("vendor/LibRaw-Wasm/example-sony.ARW");

test("experimental tiled AAHD streams an aligned RGB16 export", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_E2E !== "1",
    "Set AAHD_EXPORT_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: /example-sony\.ARW.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const productionDownload = await downloadPromise;
  const productionOutput = await productionDownload.path();
  expect(productionOutput).not.toBeNull();

  await page.goto("/?rawBackend=webgpu-aahd");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: /example-sony\.ARW.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  const runs = [];
  let browserOutput: string | null = null;
  const samples = Number(process.env.AAHD_EXPORT_SAMPLES ?? "1");
  for (let sample = 0; sample < samples; sample += 1) {
    downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await downloadPromise;
    browserOutput ??= await download.path();
    const timings = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("raw-alchemy:export-worker")
            .at(-1) as PerformanceMark
        ).detail,
    );
    expect(timings.rawBackend).toBe("webgpu-aahd");
    expect(timings.colorBackend).toBe("webgpu");
    runs.push(timings);
  }
  expect(browserOutput).not.toBeNull();

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(productionOutput!),
  );
  expect([comparison.width, comparison.height]).toEqual([6_240, 4_168]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
  expect(comparison.samplesOverTwoCodes).toBe(0);
  const reportPath = testInfo.outputPath("aahd-export-performance.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      { comparison, coldRun: runs[0], warmRuns: runs.slice(1) },
      null,
      2,
    ),
  );
  await testInfo.attach("aahd-export-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });
});
