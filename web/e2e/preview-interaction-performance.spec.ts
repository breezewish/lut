import { expect, type Page, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.RAW_PERF === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);

type Draw = {
  at: number;
  label: string | null;
  width: number;
};

type Measurement = Awaited<ReturnType<typeof measure>>;

test("records production preview interaction latency", async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set RAW_PERF=1 to run the formal performance benchmark.",
  );
  test.setTimeout(3 * 60_000);

  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.putImageData;
    const state = window as Window & { previewDraws?: Draw[] };
    state.previewDraws = [];
    CanvasRenderingContext2D.prototype.putImageData = function (
      imageData,
      dx,
      dy,
    ) {
      state.previewDraws?.push({
        at: performance.now(),
        label: this.canvas.getAttribute("aria-label"),
        width: this.canvas.width,
      });
      Reflect.apply(original, this, [imageData, dx, dy]);
    };
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const basePreview = page.getByLabel("Base preview");
  await expect(basePreview).toBeVisible({
    timeout: 60_000,
  });
  await expect(basePreview).toHaveAttribute("width", "1024");

  const exposure = page.getByRole("slider", { name: "Exposure" });
  const ev: Measurement[] = [];
  for (let index = 0; index < 20; index += 1) {
    ev.push(
      await measure(page, async () =>
        exposure.fill(String(((index % 8) + 1) / 10)),
      ),
    );
  }

  const luts = await page.evaluate(async () => {
    const response = await fetch("./luts/manifest.json");
    return (await response.json()).luts as { id: string; name: string }[];
  });
  const coldLuts: Array<Measurement & { id: string; name: string }> = [];
  for (const lut of luts.filter(
    (candidate) => candidate.id !== "fuji-classic-negative",
  )) {
    coldLuts.push({
      ...(await chooseLook(page, lut.name)),
      id: lut.id,
      name: lut.name,
    });
  }

  const warmLuts: Measurement[] = [];
  for (let index = 0; index < 20; index += 1) {
    warmLuts.push(await chooseLook(page, luts[index % 2].name));
  }

  const summary = {
    ev: summarize(ev),
    coldLuts: summarize(coldLuts),
    warmLuts: summarize(warmLuts),
  };

  const report = Buffer.from(
    JSON.stringify(
      { schemaVersion: 2, fixture, summary, ev, coldLuts, warmLuts },
      null,
      2,
    ),
  );
  const reportPath = testInfo.outputPath(
    "preview-interaction-performance.json",
  );
  await writeFile(reportPath, report);
  await testInfo.attach("preview-interaction-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(summary.ev.firstFrameP95Ms).toBeLessThan(200);
  expect(summary.ev.settledFrameP95Ms).toBeLessThan(500);
  expect(summary.coldLuts.settledFrameP95Ms).toBeLessThan(500);
  expect(summary.warmLuts.firstFrameP95Ms).toBeLessThan(200);
});

async function chooseLook(page: Page, name: string) {
  return measure(page, async () => {
    await page.getByRole("combobox", { name: "Built-in V-Log look" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  });
}

async function measure(page: Page, change: () => Promise<void>) {
  await page.evaluate(() => {
    (window as Window & { previewDraws?: Draw[] }).previewDraws = [];
    performance.clearMarks("raw-alchemy:preview-render");
  });
  const startedAt = await page.evaluate(() => performance.now());
  await change();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const draws = (window as Window & { previewDraws?: Draw[] })
          .previewDraws;
        return draws?.some((draw) => draw.width === 1_024) ?? false;
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled();
  const draws = await page.evaluate(
    () => (window as Window & { previewDraws?: Draw[] }).previewDraws ?? [],
  );
  const worker = await page.evaluate(() =>
    performance
      .getEntriesByName("raw-alchemy:preview-render")
      .map((entry) => (entry as PerformanceMark).detail),
  );
  return {
    firstFrameMs: draws[0].at - startedAt,
    settledFrameMs: draws.find((draw) => draw.width === 1_024)!.at - startedAt,
    draws,
    worker,
  };
}

function summarize(measurements: Measurement[]) {
  return {
    samples: measurements.length,
    firstFrameP95Ms: percentile(
      measurements.map(({ firstFrameMs }) => firstFrameMs),
      0.95,
    ),
    settledFrameP95Ms: percentile(
      measurements.map(({ settledFrameMs }) => settledFrameMs),
      0.95,
    ),
  };
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}
