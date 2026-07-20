import { expect, test } from "@playwright/test";

test("tiled AAHD matches pinned parity outputs across seams and CFA phases", async ({
  page,
}) => {
  test.skip(
    process.env.AAHD_TILE_E2E !== "1",
    "Set AAHD_TILE_E2E=1 to run the WebGPU correctness suite.",
  );
  test.setTimeout(5 * 60_000);
  await page.goto("/?aahdTileBenchmark=1");
  await expect
    .poll(() => page.locator("body").getAttribute("data-benchmark-status"), {
      timeout: 5 * 60_000,
    })
    .toMatch(/^(complete|error)$/);
  const error = await page.locator("body").getAttribute("data-benchmark-error");
  expect(error).toBeNull();
  const report = await page.evaluate(
    () =>
      (
        performance
          .getEntriesByName("lutify:aahd-tile-benchmark")
          .at(-1) as PerformanceMark
      ).detail,
  );
  expect(report.results).toHaveLength(6);
  for (const result of report.results) {
    expect(result.hash, result.name).toBe(result.expectedHash);
    expect(result.resources.peakGpuBytes).toBeLessThanOrEqual(
      256 * 1024 * 1024,
    );
  }
  expect(report.results.at(-1).blackLevels).toEqual([64, 96, 192, 96]);
});
