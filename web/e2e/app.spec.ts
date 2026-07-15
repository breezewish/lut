import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

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
  const comparison = page.getByRole("region", {
    name: "Base and LUT comparison",
  });
  await expect(comparison).toHaveAttribute("data-decode-count", "1");
  const baseBeforeExposure = await page
    .getByLabel("Base preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toHaveValue("1");
  await expect
    .poll(() =>
      page
        .getByLabel("Base preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(baseBeforeExposure);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  const classicNegativePreview = await page
    .getByLabel("Classic Negative preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.getByRole("combobox", { name: "Built-in V-Log look" }).click();
  await page.getByRole("option", { name: "PROVIA", exact: true }).click();
  await expect(page.getByLabel("PROVIA preview")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByLabel("PROVIA preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  await page.getByRole("combobox", { name: "Built-in V-Log look" }).click();
  await page
    .getByRole("option", { name: "Classic Negative", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByLabel("Classic Negative preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

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
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  expect(Object.keys(archive).sort()).toEqual([
    "first-fuji-classic-negative.tif",
    "second-fuji-classic-negative.tif",
  ]);
  const first = decodeRgb16Tiff(
    Buffer.from(archive["first-fuji-classic-negative.tif"]),
  );
  const second = decodeRgb16Tiff(
    Buffer.from(archive["second-fuji-classic-negative.tif"]),
  );
  expect([first.width, first.height]).toEqual([second.width, second.height]);
  let batchMaxCodeDifference = 0;
  for (let index = 0; index < first.rgb.length; index += 1) {
    batchMaxCodeDifference = Math.max(
      batchMaxCodeDifference,
      Math.abs(first.rgb[index] - second.rgb[index]),
    );
  }
  expect(batchMaxCodeDifference).toBe(0);

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

test("all built-in LUTs match optimized native RGB16 exports", async ({
  page,
}) => {
  const manifest = JSON.parse(
    await readFile(resolve("assets/luts.json"), "utf8"),
  ) as {
    luts: Array<{ id: string; group: string; name: string; file: string }>;
  };
  const nativeAlchemy = resolve("target/release/alchemy");

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  for (const look of manifest.luts) {
    await page
      .getByRole("searchbox", { name: "Look" })
      .fill(`${look.group} ${look.name}`);
    await page.getByRole("combobox", { name: "Built-in V-Log look" }).click();
    await page.getByRole("option", { name: look.name, exact: true }).click();
    await expect(page.getByLabel(`${look.name} preview`)).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`linear-${look.id}.tif`);

    const nativeOutput = test.info().outputPath(`${look.id}.tif`);
    await execFileAsync(nativeAlchemy, [
      linearFixture,
      nativeOutput,
      "--lut",
      resolve("vendor/V-Log-Alchemy/Luts", look.file),
      "--ev",
      "0",
      "--color",
      "never",
    ]);
    const browserPath = await download.path();
    expect(browserPath).not.toBeNull();
    const browser = decodeRgb16Tiff(await readFile(browserPath!));
    const native = decodeRgb16Tiff(await readFile(nativeOutput));
    expect([browser.width, browser.height]).toEqual([
      native.width,
      native.height,
    ]);
    let maxCodeDifference = 0;
    for (let index = 0; index < browser.rgb.length; index += 1) {
      maxCodeDifference = Math.max(
        maxCodeDifference,
        Math.abs(browser.rgb[index] - native.rgb[index]),
      );
    }
    expect(maxCodeDifference, look.id).toBeLessThanOrEqual(1);
  }
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
