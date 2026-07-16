import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

const realDng = resolve("tests/fixtures/leica-m8.dng");
const sonyArw = resolve("vendor/LibRaw-Wasm/example-sony.ARW");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);

test("a real camera CFA DNG matches the native full-resolution export", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const nativeOutput = test.info().outputPath("leica-m8-native.tif");
  const nativeExport = execFileAsync(resolve("target/release/alchemy"), [
    realDng,
    nativeOutput,
    "--lut",
    classicNegative,
    "--color",
    "never",
  ]);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(realDng);
  await expect(page.getByText("Leica M8", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const basePreview = page.getByLabel("Base preview");
  await expect(basePreview).toBeVisible();
  const preview = await basePreview.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < pixels.length; index += 64) {
      minimum = Math.min(minimum, pixels[index]);
      maximum = Math.max(maximum, pixels[index]);
    }
    return { width: canvas.width, height: canvas.height, minimum, maximum };
  });
  expect(preview.width).toBe(1_600);
  expect(preview.height).toBeGreaterThan(1_000);
  expect(preview.maximum - preview.minimum).toBeGreaterThan(32);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const download = await downloadPromise;
  const browserOutput = await download.path();
  expect(browserOutput).not.toBeNull();
  await nativeExport;

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([3_920, 2_638]);
  expect(comparison.maxInteriorCodeDifference).toBeLessThanOrEqual(1);
  expect(comparison.significantlyDifferentBoundaryPixels).toBeLessThanOrEqual(
    1,
  );
  expect(comparison.maxBoundaryCodeDifference).toBeLessThanOrEqual(8_192);
});

test("a full-resolution Sony ARW export matches the native pipeline", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const nativeOutput = test.info().outputPath("sony-fx30-native.tif");

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(sonyArw);
  await expect(page.getByText("SONY ILME-FX30")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Base preview")).toBeVisible();
  const preview = page.getByRole("region", {
    name: "Base and LUT comparison",
  });
  await expect(preview).toHaveAttribute("data-decode-count", "1");

  const startedAt = Date.now();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const download = await downloadPromise;
  expect(Date.now() - startedAt).toBeLessThan(30_000);
  const browserOutput = await download.path();
  expect(browserOutput).not.toBeNull();

  await execFileAsync(resolve("target/release/alchemy"), [
    sonyArw,
    nativeOutput,
    "--lut",
    classicNegative,
    "--color",
    "never",
  ]);

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([6_240, 4_168]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(1);

  const previewBeforeRerender = await page
    .getByLabel("Base preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.getByRole("slider", { name: "Exposure" }).fill("0.5");
  await expect
    .poll(() =>
      page
        .getByLabel("Base preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(previewBeforeRerender);
  await expect(preview).toHaveAttribute("data-decode-count", "1");
});
