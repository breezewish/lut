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
  expect(preview.width).toBe(1_024);
  expect(preview.height).toBeGreaterThan(650);
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
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(1);
});

test("a full-resolution Sony ARW export matches the native pipeline", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const nativeOutput = test.info().outputPath("sony-fx30-native.tif");

  await page.addInitScript(() => {
    const originalPostMessage = Worker.prototype.postMessage;
    const state = window as Window & {
      maxAnimationFrameGap?: number;
      renderCommandCount?: number;
    };
    state.renderCommandCount = 0;
    state.maxAnimationFrameGap = 0;
    Worker.prototype.postMessage = function (...args) {
      const message = args[0] as { type?: string };
      if (message?.type === "render") {
        state.renderCommandCount = (state.renderCommandCount ?? 0) + 1;
      }
      return Reflect.apply(originalPostMessage, this, args);
    };
    let previousFrame = performance.now();
    requestAnimationFrame(function measureFrameGap(frame) {
      state.maxAnimationFrameGap = Math.max(
        state.maxAnimationFrameGap ?? 0,
        frame - previousFrame,
      );
      previousFrame = frame;
      requestAnimationFrame(measureFrameGap);
    });
  });
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

  const basePreview = page.getByLabel("Base preview");
  const evZero = await basePreview.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const luminance: number[] = [];
    let total = 0;
    for (let index = 0; index < pixels.length; index += 1_024) {
      const value =
        0.2126 * pixels[index] +
        0.7152 * pixels[index + 1] +
        0.0722 * pixels[index + 2];
      luminance.push(value);
      total += value;
    }
    return { luminance, average: total / luminance.length };
  });

  // Settle browser painting, then count only commands caused by exposure.
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const state = window as Window & {
      maxAnimationFrameGap?: number;
      renderCommandCount?: number;
    };
    state.renderCommandCount = 0;
    state.maxAnimationFrameGap = 0;
  });

  const exposure = page.getByRole("slider", { name: "Exposure" });
  await exposure.fill("0.5");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { renderCommandCount?: number })
            .renderCommandCount ?? 0,
      ),
    )
    .toBe(1);
  await page.waitForTimeout(150);
  await exposure.fill("1");
  await page.waitForTimeout(150);
  const finalInputAt = Date.now();
  await exposure.fill("1.5");
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toHaveValue("1.5");

  const finalDifference = async () =>
    basePreview.evaluate((canvas: HTMLCanvasElement, before) => {
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0;
      let absoluteDifference = 0;
      let sample = 0;
      for (let index = 0; index < pixels.length; index += 1_024) {
        const value =
          0.2126 * pixels[index] +
          0.7152 * pixels[index + 1] +
          0.0722 * pixels[index + 2];
        total += value;
        absoluteDifference += Math.abs(value - before.luminance[sample]);
        sample += 1;
      }
      return {
        average: total / sample,
        meanAbsoluteDifference: absoluteDifference / sample,
      };
    }, evZero);

  await expect
    .poll(async () => (await finalDifference()).meanAbsoluteDifference, {
      timeout: 3_000,
    })
    .toBeGreaterThan(5);
  expect(Date.now() - finalInputAt).toBeLessThan(3_000);
  const finalPreview = await finalDifference();
  expect(finalPreview.average - evZero.average).toBeGreaterThan(2);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { renderCommandCount?: number })
          .renderCommandCount ?? 0,
    ),
  ).toBeLessThanOrEqual(2);
  const maxAnimationFrameGap = await page.evaluate(
    () =>
      (window as Window & { maxAnimationFrameGap?: number })
        .maxAnimationFrameGap ?? 0,
  );
  expect(maxAnimationFrameGap).toBeGreaterThan(0);
  expect(maxAnimationFrameGap).toBeLessThanOrEqual(250);
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
    "--ev",
    "1.5",
    "--color",
    "never",
  ]);

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([6_240, 4_168]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(1);
});
