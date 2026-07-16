import { expect, type Page, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.RAW_PERF === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const minimumFixturePixels = Number(process.env.RAW_PERF_MIN_PIXELS ?? "0");
const settledPreviewBudgetMs = minimumFixturePixels >= 33_000_000 ? 700 : 500;

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
  expect(summary.ev.settledFrameP95Ms).toBeLessThan(settledPreviewBudgetMs);
  expect(summary.coldLuts.settledFrameP95Ms).toBeLessThan(500);
  expect(summary.warmLuts.firstFrameP95Ms).toBeLessThan(200);
});

test("keeps painting fresh frames during continuous EV input", async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set RAW_PERF=1 to run the formal performance benchmark.",
  );
  test.setTimeout(60_000);

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
  await expect(basePreview).toHaveAttribute("width", "1024", {
    timeout: 60_000,
  });

  const burst = await page.evaluate(async () => {
    const state = window as Window & { previewDraws?: Draw[] };
    state.previewDraws = [];
    performance.clearMarks("raw-alchemy:preview-render");
    const input = document.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );
    if (!input) throw new Error("Exposure slider is missing.");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setValue) throw new Error("Exposure value setter is missing.");

    const startedAt = performance.now();
    for (let index = 0; index < 60; index += 1) {
      if (index > 0) {
        const scheduledAt = startedAt + (index * 1_000) / 60;
        await new Promise((resolve) =>
          window.setTimeout(
            resolve,
            Math.max(0, scheduledAt - performance.now()),
          ),
        );
      }
      const value = index === 59 ? 1 : ((index % 20) - 10) / 10;
      setValue.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return { startedAt, endedAt: performance.now() };
  });

  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled({ timeout: 5_000 });
  const baseFrames = await page.evaluate(
    () =>
      (window as Window & { previewDraws?: Draw[] }).previewDraws?.filter(
        ({ label }) => label === "Base preview",
      ) ?? [],
  );
  const interactive = baseFrames.filter(({ width }) => width === 256);
  const settled = [...baseFrames]
    .reverse()
    .find(({ width }) => width === 1_024);
  const summary = {
    inputDurationMs: burst.endedAt - burst.startedAt,
    interactiveFrames: interactive.length,
    firstFrameMs: interactive[0].at - burst.startedAt,
    finalInteractiveMs: interactive.at(-1)!.at - burst.endedAt,
    settledMs: settled ? settled.at - burst.endedAt : undefined,
  };
  const reportPath = testInfo.outputPath("continuous-ev-performance.json");
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  await testInfo.attach("continuous-ev-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(burst.endedAt - burst.startedAt).toBeLessThan(1_100);
  expect(interactive.length).toBeGreaterThanOrEqual(12);
  expect(interactive[0].at - burst.startedAt).toBeLessThan(80);
  expect(interactive.at(-1)!.at - burst.endedAt).toBeLessThan(100);
  expect(settled).toBeDefined();
  expect(settled!.at - burst.endedAt).toBeLessThan(500);
});

test("keeps the interface responsive while a large RAW is decoding and exposure is dragged", async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set RAW_PERF=1 to run the formal performance benchmark.",
  );
  test.setTimeout(60_000);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    const state = window as Window & {
      exposureDragFrames?: number[];
      exposureDragInputs?: number[];
    };
    state.exposureDragFrames = [];
    state.exposureDragInputs = [];
    const recordFrame = (at: number) => {
      state.exposureDragFrames?.push(at);
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
    addEventListener(
      "input",
      (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === "range"
        ) {
          state.exposureDragInputs?.push(performance.now());
        }
      },
      true,
    );
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const exposure = page.getByRole("slider", { name: "Exposure" });
  await expect(exposure).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      exposureDragFrames?: number[];
      exposureDragInputs?: number[];
    };
    state.exposureDragFrames = [];
    state.exposureDragInputs = [];
  });

  const bounds = await exposure.boundingBox();
  if (!bounds) throw new Error("Exposure slider has no visible bounds.");
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 1, y);
  await page.mouse.down();
  for (let index = 0; index < 60; index += 1) {
    await page.mouse.move(bounds.x + 1 + ((bounds.width - 2) * index) / 59, y);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await page.mouse.up();

  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );

  const measurement = await page.evaluate(() => {
    const state = window as Window & {
      exposureDragFrames?: number[];
      exposureDragInputs?: number[];
    };
    const frames = state.exposureDragFrames ?? [];
    const inputs = state.exposureDragInputs ?? [];
    const dragStartedAt = inputs[0];
    const dragEndedAt = inputs.at(-1);
    const frameGaps = frames.slice(1).map((at, index) => ({
      at,
      previousAt: frames[index],
      duration: at - frames[index],
    }));
    return {
      inputCount: inputs.length,
      interactionFrameGaps: frameGaps
        .filter(
          ({ at, previousAt }) =>
            at >= dragStartedAt && previousAt <= dragEndedAt,
        )
        .map(({ duration }) => duration),
      observedFrameGapMax: Math.max(
        ...frameGaps.map(({ duration }) => duration),
      ),
    };
  });
  const frameGapP95 = percentile(measurement.interactionFrameGaps, 0.95);
  const frameGapMax = Math.max(...measurement.interactionFrameGaps);
  const documentContext =
    (await page.getByLabel("Current document").textContent()) ?? "";
  const dimensions = documentContext.match(/(\d+)\s*×\s*(\d+)/);
  if (!dimensions) throw new Error("Decoded RAW dimensions are unavailable.");
  const sourcePixels = Number(dimensions[1]) * Number(dimensions[2]);
  const reportPath = testInfo.outputPath("large-raw-drag-performance.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        fixture,
        sourcePixels,
        inputCount: measurement.inputCount,
        frameGapP95,
        frameGapMax,
        observedFrameGapMax: measurement.observedFrameGapMax,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach("large-raw-drag-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(measurement.inputCount).toBeGreaterThanOrEqual(45);
  expect(sourcePixels).toBeGreaterThanOrEqual(minimumFixturePixels);
  expect(frameGapP95).toBeLessThan(25);
  expect(frameGapMax).toBeLessThan(100);
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
