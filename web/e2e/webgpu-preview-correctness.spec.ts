import { expect, test } from "@playwright/test";

test("WebGPU Preview matches the independent corrected-v2 pixel oracle", async ({
  page,
}) => {
  test.skip(
    process.env.WEBGPU_PREVIEW_E2E !== "1",
    "Set WEBGPU_PREVIEW_E2E=1 to run the WebGPU Preview oracle.",
  );
  await page.goto("/?previewCorrectness=1");
  await expect
    .poll(() => page.locator("body").getAttribute("data-benchmark-status"))
    .not.toBe("running");
  expect(
    await page.locator("body").getAttribute("data-benchmark-error"),
  ).toBeNull();
  const report = await page.evaluate(
    () =>
      (
        performance
          .getEntriesByName("lutify:preview-correctness")
          .at(-1) as PerformanceMark
      ).detail,
  );
  expect(report.results).toHaveLength(3);
  for (const result of report.results) {
    expect(result.baseMaximumDifference, result.name).toBeLessThanOrEqual(1);
    expect(result.lutMaximumDifference, result.name).toBeLessThanOrEqual(1);
  }
});
