import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

const fixture = resolve("vendor/LibRaw-Wasm/example-sony.ARW");
const secondCameraFixture = resolve("tests/fixtures/leica-m8.dng");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);

test("tiled AAHD streams repeated aligned RGB16 exports", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_E2E !== "1",
    "Set AAHD_EXPORT_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(5 * 60_000);
  const nativeOutput = testInfo.outputPath("sony-native.tif");
  await nativeExport(fixture, nativeOutput);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: /example-sony\.ARW.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  const runs = [];
  const browserOutputs: string[] = [];
  const samples = Number(process.env.AAHD_EXPORT_SAMPLES ?? "5");
  for (let sample = 0; sample < samples; sample += 1) {
    const downloadPromise = page.waitForEvent("download");
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
  const nativeTiff = await readFile(nativeOutput);
  const comparisons = [];
  for (const browserOutput of browserOutputs) {
    const comparison = compareRgb16Tiffs(
      await readFile(browserOutput),
      nativeTiff,
    );
    expect([comparison.width, comparison.height]).toEqual([6_240, 4_168]);
    expectAahdAlignment(comparison);
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

test("tiled AAHD aligns on a second Bayer camera", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_MATRIX_E2E !== "1",
    "Set AAHD_EXPORT_MATRIX_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(3 * 60_000);

  const nativeOutput = testInfo.outputPath("leica-native.tif");
  await nativeExport(secondCameraFixture, nativeOutput);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(secondCameraFixture);
  await expect(
    page.getByRole("button", { name: /leica-m8\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const browserDownload = await downloadPromise;
  const browserOutput = await browserDownload.path();
  expect(browserOutput).not.toBeNull();

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  const reportPath = testInfo.outputPath("aahd-export-leica-comparison.json");
  await writeFile(reportPath, JSON.stringify(comparison, null, 2));
  await testInfo.attach("aahd-export-leica-comparison.json", {
    path: reportPath,
    contentType: "application/json",
  });
  expect([comparison.width, comparison.height]).toEqual([3_920, 2_638]);
  expectAahdAlignment(comparison);
});

test("tiled AAHD matches LibRaw auto WB", async ({ page }, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_MATRIX_E2E !== "1",
    "Set AAHD_EXPORT_MATRIX_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(3 * 60_000);
  const modified = withoutDngAsShotNeutral(await readFile(secondCameraFixture));
  const fixturePath = testInfo.outputPath("leica-m8-no-camera-wb.dng");
  const nativeOutput = testInfo.outputPath("leica-m8-no-camera-wb-native.tif");
  await writeFile(fixturePath, modified);
  await nativeExport(fixturePath, nativeOutput);
  const file = {
    name: "leica-m8-no-camera-wb.dng",
    mimeType: "image/x-adobe-dng",
    buffer: modified,
  };

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(
    page.getByRole("button", { name: /leica-m8-no-camera-wb\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const browserOutput = await (await downloadPromise).path();
  expect(browserOutput).not.toBeNull();

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([3_920, 2_638]);
  expectAahdAlignment(comparison);
});

test("rotated Bayer keeps LibRaw geometry and required GPU color", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_EXPORT_MATRIX_E2E !== "1",
    "Set AAHD_EXPORT_MATRIX_E2E=1 on a hardware WebGPU runner.",
  );
  test.setTimeout(3 * 60_000);
  const modified = Buffer.from(await readFile(secondCameraFixture));
  setDngOrientation(modified, 6);
  const fixturePath = testInfo.outputPath("leica-m8-rotated.dng");
  const nativeOutput = testInfo.outputPath("leica-m8-rotated-native.tif");
  await writeFile(fixturePath, modified);
  await nativeExport(fixturePath, nativeOutput);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await expect(
    page.getByRole("button", { name: /leica-m8-rotated\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const browserOutput = await (await downloadPromise).path();
  expect(browserOutput).not.toBeNull();
  const timings = await page.evaluate(
    () =>
      (
        performance
          .getEntriesByName("raw-alchemy:export-worker")
          .at(-1) as PerformanceMark
      ).detail,
  );
  expect(timings.rawBackend).toBe("libraw");
  expect(timings.colorBackend).toBe("webgpu");

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([2_638, 3_920]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(1);
});

async function nativeExport(input: string, output: string): Promise<void> {
  await execFileAsync(resolve("target/release/alchemy"), [
    input,
    output,
    "--lut",
    classicNegative,
    "--color",
    "never",
  ]);
}

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

function setDngOrientation(bytes: Buffer, orientation: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = String.fromCharCode(bytes[0], bytes[1]) === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (view.getUint16(entryOffset, littleEndian) === 274) {
      view.setUint16(entryOffset + 8, orientation, littleEndian);
      return;
    }
  }
  throw new Error("Leica fixture has no Orientation tag");
}

function expectAahdAlignment(
  comparison: ReturnType<typeof compareRgb16Tiffs>,
): void {
  if (process.env.WEBGPU_SOFTWARE === "1") {
    // SwiftShader has a stable six-code floating-point ceiling on the full
    // production path. Hardware remains held to the two-code contract.
    expect(comparison.maxCodeDifference).toBeLessThanOrEqual(6);
    expect(comparison.samplesOverSixCodes).toBe(0);
    return;
  }
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
  expect(comparison.samplesOverTwoCodes).toBe(0);
}
