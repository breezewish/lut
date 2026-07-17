import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { compareRgb16Tiffs } from "./tiff";

interface CameraFixture {
  id: string;
  file: string;
  camera: string;
  width: number;
  height: number;
}

const fixtureRoot = resolve(
  process.env.WEBGPU_CAMERA_FIXTURE_DIR ??
    "tests/fixtures/webgpu-camera-matrix",
);
const manifest = JSON.parse(
  await readFile("tests/fixtures/webgpu-camera-matrix.json", "utf8"),
) as { fixtures: CameraFixture[] };

for (const fixture of manifest.fixtures) {
  test(`experimental tiled AAHD aligns ${fixture.camera} export`, async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.WEBGPU_CAMERA_MATRIX_E2E !== "1",
      "Run npm run test:webgpu-camera-matrix on a hardware WebGPU runner.",
    );
    test.setTimeout(5 * 60_000);

    const path = resolve(fixtureRoot, fixture.file);
    const productionOutput = await exportSelected(page, path, "/");
    const webGpuOutput = await exportSelected(
      page,
      path,
      "/?rawBackend=webgpu-aahd",
    );
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
    expect(adapterInfo).toBeDefined();
    expect(adapterInfo?.isFallbackAdapter).toBe(false);

    const comparison = compareRgb16Tiffs(
      await readFile(webGpuOutput),
      await readFile(productionOutput),
    );
    expect([comparison.width, comparison.height]).toEqual([
      fixture.width,
      fixture.height,
    ]);
    expect(comparison.maxCodeDifference).toBeLessThanOrEqual(2);
    expect(comparison.samplesOverTwoCodes).toBe(0);

    const reportPath = testInfo.outputPath(`${fixture.id}-comparison.json`);
    await writeFile(
      reportPath,
      JSON.stringify({ fixture, adapterInfo, comparison, timings }, null, 2),
    );
    await testInfo.attach(`${fixture.id}-comparison.json`, {
      path: reportPath,
      contentType: "application/json",
    });
  });
}

async function exportSelected(page: Page, fixture: string, route: string) {
  await page.goto(route);
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const exportButton = page.getByRole("button", { name: "Export selected" });
  await expect(exportButton).toBeEnabled({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const output = await (await downloadPromise).path();
  expect(output).not.toBeNull();
  return output!;
}
