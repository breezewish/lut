import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

const enabled = process.env.WEBGPU_PREVIEW === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);

type PreviewTiming = {
  lutId: string;
  previewBackend: "webgpu";
  gpuExecutionAndReadbackMs: number;
};

test("renders full-detail interaction with every built-in LUT on WebGPU", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "Set WEBGPU_PREVIEW=1 to run the hardware preview test.");
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.putImageData;
    const state = window as Window & { previewWidths?: number[] };
    state.previewWidths = [];
    CanvasRenderingContext2D.prototype.putImageData = function (
      imageData,
      dx,
      dy,
    ) {
      if (this.canvas.getAttribute("aria-label") === "Base preview") {
        state.previewWidths?.push(this.canvas.width);
      }
      Reflect.apply(original, this, [imageData, dx, dy]);
    };
  });

  await page.goto("/");
  const adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({
      powerPreference: "high-performance",
    });
    return adapter
      ? {
          description: adapter.info.description,
          isFallbackAdapter: adapter.info.isFallbackAdapter,
        }
      : undefined;
  });
  expect(adapter).toBeDefined();
  expect(adapter?.isFallbackAdapter).toBe(false);

  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    (window as Window & { previewWidths?: number[] }).previewWidths = [];
    performance.clearMarks("raw-alchemy:preview-render");
  });

  await page.getByRole("slider", { name: "Exposure" }).fill("0.7");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { previewWidths?: number[] }).previewWidths
            ?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  const widths = await page.evaluate(
    () => (window as Window & { previewWidths?: number[] }).previewWidths ?? [],
  );
  expect(widths[0]).toBe(1_024);
  const timing = await page.evaluate(() => {
    const entry = performance
      .getEntriesByName("raw-alchemy:preview-render")
      .at(-1) as PerformanceMark | undefined;
    return entry?.detail as PreviewTiming | undefined;
  });
  if (!timing) throw new Error("No WebGPU Preview timing was recorded.");
  expect(timing.previewBackend).toBe("webgpu");
  expect(timing.gpuExecutionAndReadbackMs).toBeLessThan(50);
  const validations = [timing];
  const luts = await page.evaluate(async () => {
    const response = await fetch("./luts/manifest.json");
    return (await response.json()).luts as Array<{ id: string; name: string }>;
  });
  for (const lut of luts.filter(({ id }) => id !== timing.lutId)) {
    await page.evaluate(() =>
      performance.clearMarks("raw-alchemy:preview-render"),
    );
    await page.getByRole("button", { name: lut.name, exact: true }).click();
    await expect
      .poll(() => latestTiming(page, lut.id))
      .toMatchObject({ lutId: lut.id, previewBackend: "webgpu" });
    const lutTiming = await latestTiming(page, lut.id);
    if (!lutTiming)
      throw new Error(`No Preview timing was recorded for ${lut.id}.`);
    validations.push(lutTiming);
  }
  await testInfo.attach("webgpu-preview-timing.json", {
    body: Buffer.from(`${JSON.stringify(validations, null, 2)}\n`),
    contentType: "application/json",
  });
});

async function latestTiming(page: Page, lutId: string) {
  return page.evaluate((expectedLutId) => {
    const details = performance
      .getEntriesByName("raw-alchemy:preview-render")
      .map(
        (candidate) => (candidate as PerformanceMark).detail as PreviewTiming,
      );
    return details.reverse().find(({ lutId }) => lutId === expectedLutId);
  }, lutId);
}
