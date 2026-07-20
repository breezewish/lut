import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

interface XtransFixture {
  camera: string;
  file: string;
  width: number;
  height: number;
  rawBackend?: string;
  demosaicSha256?: string;
  minimumHighlights?: number;
}

const manifest = JSON.parse(
  await readFile("tests/fixtures/webgpu-camera-matrix.json", "utf8"),
) as { fixtures: XtransFixture[] };
const fixtures = manifest.fixtures.filter(
  (fixture) => fixture.rawBackend === "webgpu-xtrans",
);

for (const fixture of fixtures)
  test(`WebGPU X-Trans demosaic matches LibRaw for ${fixture.camera}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.XTRANS_PARITY_E2E !== "1",
      "Set XTRANS_PARITY_E2E=1 to run the hardware X-Trans parity suite.",
    );
    test.setTimeout(5 * 60_000);
    expect(fixture.demosaicSha256).toMatch(/^[0-9a-f]{64}$/);
    await page.goto(
      `/?xtransParity=1&expectedDemosaicSha256=${fixture.demosaicSha256}`,
    );
    await page
      .getByLabel("X-Trans RAW fixture")
      .setInputFiles(`tests/fixtures/webgpu-camera-matrix/${fixture.file}`);
    await expect
      .poll(() => page.locator("body").getAttribute("data-benchmark-status"), {
        timeout: 5 * 60_000,
      })
      .not.toBe("running");
    const error = await page
      .locator("body")
      .getAttribute("data-benchmark-error");
    expect(error).toBeNull();
    const report = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("lutify:xtrans-parity")
            .at(-1) as PerformanceMark
        ).detail,
    );
    await testInfo.attach("xtrans-parity.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    expect(report.width).toBe(fixture.width);
    expect(report.height).toBe(fixture.height);
    expect(report.actualHash).toBe(report.expectedHash);
    expect(report.highlightPixelCount).toBeGreaterThanOrEqual(
      fixture.minimumHighlights ?? 0,
    );
  });
