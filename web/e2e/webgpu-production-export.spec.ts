import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

const fixture = resolve("tests/fixtures/packed-12.dng");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);

test("SwiftShader runs the production WebGPU AAHD export path", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AAHD_SOFTWARE_E2E !== "1",
    "Set AAHD_SOFTWARE_E2E=1 to run the bounded SwiftShader export gate.",
  );
  test.setTimeout(5 * 60_000);

  await page.goto("/");
  const adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter
      ? { isFallbackAdapter: adapter.info.isFallbackAdapter }
      : undefined;
  });
  expect(adapter).toEqual({ isFallbackAdapter: true });

  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: /packed-12\.dng.*Ready/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("slider", { name: "White balance temperature" })
    .fill("42");
  await page.getByRole("slider", { name: "White balance tint" }).fill("-58");
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected as TIFF" }).click();
  const browserOutput = await (await downloadPromise).path();
  expect(browserOutput).not.toBeNull();

  const timings = await page.evaluate(
    () =>
      (
        performance
          .getEntriesByName("lutify:export-worker")
          .at(-1) as PerformanceMark
      ).detail,
  );
  expect(timings.rawBackend).toBe("webgpu-aahd");
  expect(timings.colorBackend).toBe("webgpu");

  const nativeOutput = testInfo.outputPath("packed-12-native.tif");
  await promisify(execFile)(resolve("target/release/lutify"), [
    fixture,
    nativeOutput,
    "--lut",
    classicNegative,
    "--ev",
    String(timings.effectiveEv),
    "--temperature",
    "42",
    "--tint",
    "-58",
    "--color",
    "never",
  ]);

  const comparison = compareRgb16Tiffs(
    await readFile(browserOutput!),
    await readFile(nativeOutput),
  );
  expect([comparison.width, comparison.height]).toEqual([1_024, 1_024]);
  expect(comparison.maxCodeDifference).toBeLessThanOrEqual(6);
  expect(comparison.samplesOverSixCodes).toBe(0);
});
