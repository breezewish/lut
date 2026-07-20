import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

interface CameraFixture {
  id: string;
  file: string;
  camera: string;
  width: number;
  height: number;
  rawBackend?: "libraw" | "webgpu-aahd" | "webgpu-xtrans";
  sensorCache?: boolean;
}

const fixtureRoot = resolve(
  process.env.WEBGPU_CAMERA_FIXTURE_DIR ??
    "tests/fixtures/webgpu-camera-matrix",
);
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);
const manifest = JSON.parse(
  await readFile("tests/fixtures/webgpu-camera-matrix.json", "utf8"),
) as { fixtures: CameraFixture[] };

for (const fixture of manifest.fixtures) {
  test(`GPU export aligns ${fixture.camera}`, async ({ page }, testInfo) => {
    test.skip(
      process.env.WEBGPU_CAMERA_MATRIX_E2E !== "1",
      "Run npm run test:webgpu-camera-matrix on a hardware WebGPU runner.",
    );
    test.setTimeout(5 * 60_000);

    const path = resolve(fixtureRoot, fixture.file);
    const nativeOutput = testInfo.outputPath(`${fixture.id}-native.tif`);
    const webGpuOutput = await exportSelected(page, path);
    const previewTimings = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("lutify:preview-worker")
            .at(-1) as PerformanceMark
        ).detail,
    );
    const timings = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("lutify:export-worker")
            .at(-1) as PerformanceMark
        ).detail,
    );
    await execFileAsync(resolve("target/release/lutify"), [
      path,
      nativeOutput,
      "--lut",
      classicNegative,
      "--ev",
      String(timings.effectiveEv),
      "--color",
      "never",
    ]);
    const adapterInfo = await page.evaluate(async () => {
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
    const webGpuBytes = await readFile(webGpuOutput);
    const retainedOutput = testInfo.outputPath(`${fixture.id}-webgpu.tif`);
    await writeFile(retainedOutput, webGpuBytes);
    const comparison = compareRgb16Tiffs(
      webGpuBytes,
      await readFile(nativeOutput),
    );
    const reportPath = testInfo.outputPath(`${fixture.id}-comparison.json`);
    await writeFile(
      reportPath,
      JSON.stringify(
        { fixture, adapterInfo, comparison, previewTimings, timings },
        null,
        2,
      ),
    );
    await testInfo.attach(`${fixture.id}-comparison.json`, {
      path: reportPath,
      contentType: "application/json",
    });
    expect(timings.rawBackend).toBe(fixture.rawBackend ?? "webgpu-aahd");
    expect(timings.colorBackend).toBe("webgpu");
    if (fixture.sensorCache ?? timings.rawBackend !== "libraw") {
      expect(timings.sensorCacheHit).toBe(true);
      expect(timings.sensorCacheBytes).toBe(fixture.width * fixture.height * 2);
      expect(timings.libraw.totalMs).toBe(0);
    } else {
      expect(timings.sensorCacheHit).not.toBe(true);
    }
    expect(adapterInfo).toBeDefined();
    if (process.env.WEBGPU_HARDWARE === "1") {
      expect(adapterInfo?.isFallbackAdapter).toBe(false);
    }
    expect([comparison.width, comparison.height]).toEqual([
      fixture.width,
      fixture.height,
    ]);
    expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
    expect(comparison.samplesOverTwoCodes).toBe(0);
  });
}

async function exportSelected(page: Page, fixture: string) {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const exportButton = page.getByRole("button", { name: "Export selected" });
  await expect(exportButton).toBeEnabled({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const output = await (await downloadPromise).path();
  expect(output).not.toBeNull();
  return output!;
}
