import { expect, test } from "@playwright/test";

const fixtures = [
  ["Fujifilm X-T2", "fujifilm-x-t2.RAF", 6032, 4028, 0],
  ["Fujifilm X-T1", "fujifilm-x-t1.RAF", 4934, 3296, 1],
] as const;

for (const [camera, file, width, height, minimumHighlights] of fixtures)
  test(`WebGPU X-Trans demosaic matches LibRaw for ${camera}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.XTRANS_PARITY_E2E !== "1",
      "Set XTRANS_PARITY_E2E=1 to run the hardware X-Trans parity suite.",
    );
    test.setTimeout(5 * 60_000);
    await page.goto("/?xtransParity=1");
    await page
      .getByLabel("X-Trans RAW fixture")
      .setInputFiles(`tests/fixtures/webgpu-camera-matrix/${file}`);
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
    expect(report.width).toBe(width);
    expect(report.height).toBe(height);
    expect(report.maximumDifference).toBeLessThanOrEqual(2);
    expect(report.differingSamples).toBe(0);
    expect(report.highlightPixelCount).toBeGreaterThanOrEqual(
      minimumHighlights,
    );
  });
