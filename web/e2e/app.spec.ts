import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { decodeRgb16Tiff } from "./tiff";

const linearFixture = resolve("tests/fixtures/linear.dng");
const lossyFixture = resolve("vendor/LibRaw-Wasm/test/integration/lossy.dng");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);

test("decodes, re-renders exposure, and exports a local RAW", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByText("Base", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Unknown camera")).toHaveCount(0);

  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toHaveValue("1");
  await expect(page.getByLabel("Base preview")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/fuji-classic-negative\.tif$/);

  const nativeOutput = test.info().outputPath("native.tif");
  await execFileAsync("cargo", [
    "run",
    "--quiet",
    "-p",
    "alchemy-cli",
    "--",
    linearFixture,
    nativeOutput,
    "--lut",
    classicNegative,
    "--ev",
    "1",
  ]);
  const browserOutput = await download.path();
  expect(browserOutput).not.toBeNull();
  const browserBytes = await readFile(browserOutput!);
  await writeFile(test.info().outputPath("browser.tif"), browserBytes);
  const browserImage = decodeRgb16Tiff(browserBytes);
  const nativeImage = decodeRgb16Tiff(await readFile(nativeOutput));
  expect([browserImage.width, browserImage.height]).toEqual([
    nativeImage.width,
    nativeImage.height,
  ]);
  let maxCodeDifference = 0;
  for (let index = 0; index < browserImage.rgb.length; index += 1) {
    maxCodeDifference = Math.max(
      maxCodeDifference,
      Math.abs(browserImage.rgb[index] - nativeImage.rgb[index]),
    );
  }
  expect(maxCodeDifference).toBeLessThanOrEqual(1);
});

test("batch export produces one ZIP and corrupt input fails clearly", async ({
  page,
}) => {
  const bytes = await readFile(lossyFixture);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "second.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
  ]);
  await expect(page.getByText("2 local files")).toBeVisible();
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export all" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "raw-alchemy-fuji-classic-negative.zip",
  );

  await page.getByRole("button", { name: "Clear queue" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "broken.dng",
    mimeType: "image/x-adobe-dng",
    buffer: Buffer.from("not a raw file"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "The file may be damaged, or its camera format may not be supported yet.",
  );
  await expect(page.getByRole("button", { name: "Remove file" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose another RAW" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeDisabled();
});

test("mobile empty state keeps import primary and defers processing controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "Add RAW files" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose RAW files" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("region", { name: "Processing controls" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export all" })).toHaveCount(0);
});
