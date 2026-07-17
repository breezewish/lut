import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

const fixture = resolve("vendor/LibRaw-Wasm/example-sony.ARW");
const secondCameraFixture = resolve("tests/fixtures/leica-m8.dng");

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
  const browserOutputs: string[] = [];
  const samples = Number(process.env.AAHD_EXPORT_SAMPLES ?? "5");
  for (let sample = 0; sample < samples; sample += 1) {
    downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await downloadPromise;
    const browserOutput = await download.path();
    expect(browserOutput).not.toBeNull();
    browserOutputs.push(browserOutput!);
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
  const productionTiff = await readFile(productionOutput!);
  const comparisons = [];
  for (const browserOutput of browserOutputs) {
    const comparison = compareRgb16Tiffs(
      await readFile(browserOutput),
      productionTiff,
    );
    expect([comparison.width, comparison.height]).toEqual([6_240, 4_168]);
    expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
    expect(comparison.samplesOverTwoCodes).toBe(0);
    comparisons.push(comparison);
  }
  const reportPath = testInfo.outputPath("aahd-export-performance.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        comparison: comparisons[0],
        warmComparisons: comparisons.slice(1),
        coldRun: runs[0],
        warmRuns: runs.slice(1),
      },
      null,
      2,
    ),
  );
  await testInfo.attach("aahd-export-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });
});

test("experimental tiled AAHD aligns on a second Bayer camera", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_MATRIX_E2E !== "1",
    "Set AAHD_EXPORT_MATRIX_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(3 * 60_000);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(secondCameraFixture);
  await expect(
    page.getByRole("button", { name: /leica-m8\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const productionDownload = await downloadPromise;
  const productionOutput = await productionDownload.path();
  expect(productionOutput).not.toBeNull();

  await page.goto("/?rawBackend=webgpu-aahd");
  await page.locator('input[type="file"]').setInputFiles(secondCameraFixture);
  await expect(
    page.getByRole("button", { name: /leica-m8\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const browserDownload = await downloadPromise;
  const browserOutput = await browserDownload.path();
  expect(browserOutput).not.toBeNull();

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(productionOutput!),
  );
  const reportPath = testInfo.outputPath("aahd-export-leica-comparison.json");
  await writeFile(reportPath, JSON.stringify(comparison, null, 2));
  await testInfo.attach("aahd-export-leica-comparison.json", {
    path: reportPath,
    contentType: "application/json",
  });
  expect([comparison.width, comparison.height]).toEqual([3_920, 2_638]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
  expect(comparison.samplesOverTwoCodes).toBe(0);
});

test("experimental tiled AAHD matches LibRaw auto WB", async ({ page }) => {
  test.skip(
    process.env.AAHD_EXPORT_MATRIX_E2E !== "1",
    "Set AAHD_EXPORT_MATRIX_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(3 * 60_000);
  const file = {
    name: "leica-m8-no-camera-wb.dng",
    mimeType: "image/x-adobe-dng",
    buffer: withoutDngAsShotNeutral(await readFile(secondCameraFixture)),
  };

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(
    page.getByRole("button", { name: /leica-m8-no-camera-wb\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const productionOutput = await (await downloadPromise).path();
  expect(productionOutput).not.toBeNull();

  await page.goto("/?rawBackend=webgpu-aahd");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(
    page.getByRole("button", { name: /leica-m8-no-camera-wb\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const browserOutput = await (await downloadPromise).path();
  expect(browserOutput).not.toBeNull();

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(productionOutput!),
  );
  expect([comparison.width, comparison.height]).toEqual([3_920, 2_638]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
  expect(comparison.samplesOverTwoCodes).toBe(0);
});

function withoutDngAsShotNeutral(source: Buffer): Buffer {
  const bytes = Buffer.from(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = String.fromCharCode(bytes[0], bytes[1]) === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (view.getUint16(entryOffset, littleEndian) === 50_728) {
      view.setUint16(entryOffset, 65_000, littleEndian);
      return bytes;
    }
  }
  throw new Error("Leica fixture has no AsShotNeutral tag");
}
