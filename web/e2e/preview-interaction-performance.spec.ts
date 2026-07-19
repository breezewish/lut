import { expect, type Page, test } from "@playwright/test";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.RAW_PERF === "1";
const hardwarePerformance = process.env.WEBGPU_HARDWARE === "1";
const fixture = resolve(
  process.env.RAW_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const minimumFixturePixels = Number(process.env.RAW_PERF_MIN_PIXELS ?? "0");

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
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const label = this.canvas.getAttribute("aria-label");
      if (label?.includes("preview")) {
        state.previewDraws?.push({
          at: performance.now(),
          label,
          width: this.canvas.width,
        });
      }
      Reflect.apply(drawImage, this, args);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
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
    hardwarePerformance,
    previewBackend: ev[0].worker.at(-1)?.previewBackend,
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

  expect(summary.previewBackend).toBe("webgpu");
  if (hardwarePerformance) {
    expect(summary.ev.firstFrameP95Ms).toBeLessThan(80);
    expect(summary.ev.settledFrameP95Ms).toBeLessThan(200);
    expect(summary.coldLuts.firstFrameP95Ms).toBeLessThan(200);
    expect(summary.coldLuts.settledFrameP95Ms).toBeLessThan(300);
    expect(summary.warmLuts.firstFrameP95Ms).toBeLessThan(200);
    expect(summary.warmLuts.settledFrameP95Ms).toBeLessThan(200);
  }
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
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const label = this.canvas.getAttribute("aria-label");
      if (label?.includes("preview")) {
        state.previewDraws?.push({
          at: performance.now(),
          label,
          width: this.canvas.width,
        });
      }
      Reflect.apply(drawImage, this, args);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
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
  const interactionFrames = baseFrames.filter(({ width }) => width === 256);
  const fullResolution = baseFrames.filter(({ width }) => width === 1_024);
  const settled = [...fullResolution].reverse().at(0);
  const previewBackend = await page.evaluate(() => {
    const entry = performance
      .getEntriesByName("raw-alchemy:preview-render")
      .at(-1) as PerformanceMark | undefined;
    return entry?.detail.previewBackend as "webgpu" | undefined;
  });
  const responsiveFrames = interactionFrames;
  if (responsiveFrames.length === 0) {
    throw new Error("Continuous EV input produced no Preview frames.");
  }
  const summary = {
    hardwarePerformance,
    previewBackend,
    inputDurationMs: burst.endedAt - burst.startedAt,
    interactionFrames: interactionFrames.length,
    fullResolutionFrames: fullResolution.length,
    firstFrameMs: responsiveFrames[0].at - burst.startedAt,
    finalResponsiveFrameMs: responsiveFrames.at(-1)!.at - burst.endedAt,
    settledMs: settled ? settled.at - burst.endedAt : undefined,
  };
  const reportPath = testInfo.outputPath("continuous-ev-performance.json");
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  await testInfo.attach("continuous-ev-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(burst.endedAt - burst.startedAt).toBeLessThan(1_100);
  expect(previewBackend).toBe("webgpu");
  expect(responsiveFrames.length).toBeGreaterThanOrEqual(2);
  if (hardwarePerformance) {
    expect(responsiveFrames.length).toBeGreaterThanOrEqual(30);
    expect(responsiveFrames[0].at - burst.startedAt).toBeLessThan(80);
    expect(responsiveFrames.at(-1)!.at - burst.endedAt).toBeLessThan(100);
  }
  expect(settled).toBeDefined();
  expect(settled!.at - burst.endedAt).toBeLessThan(
    hardwarePerformance ? 500 : 700,
  );
});

test("switches back to a warm RAW without blocking the interface", async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set RAW_PERF=1 to run the formal performance benchmark.",
  );
  test.setTimeout(3 * 60_000);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    const state = window as Window & {
      rawSwitchStartedAt?: number;
      rawSwitchDraws?: Array<{
        at: number;
        duration: number;
        width: number;
        label: string | null;
        kind: "bitmap" | "pixels";
      }>;
      rawSwitchResizes?: Array<{ at: number; dimension: "width" | "height" }>;
      rawSwitchFrames?: number[];
      rawSwitchLongTasks?: Array<{ at: number; duration: number }>;
    };
    state.rawSwitchDraws = [];
    state.rawSwitchFrames = [];
    state.rawSwitchLongTasks = [];
    state.rawSwitchResizes = [];
    addEventListener(
      "pointerdown",
      (event) => {
        if ((event.target as HTMLElement).closest(".photo")) {
          state.rawSwitchStartedAt = performance.now();
        }
      },
      true,
    );
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.rawSwitchLongTasks?.push({
          at: entry.startTime,
          duration: entry.duration,
        });
      }
    }).observe({ type: "longtask" });
    const record = (
      canvas: HTMLCanvasElement,
      startedAt: number,
      kind: "bitmap" | "pixels",
    ) => {
      state.rawSwitchDraws?.push({
        at: startedAt,
        duration: performance.now() - startedAt,
        width: canvas.width,
        label: canvas.getAttribute("aria-label"),
        kind,
      });
    };
    for (const dimension of ["width", "height"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLCanvasElement.prototype,
        dimension,
      )!;
      Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
        ...descriptor,
        set(value: number) {
          if (state.rawSwitchStartedAt !== undefined) {
            state.rawSwitchResizes?.push({ at: performance.now(), dimension });
          }
          descriptor.set!.call(this, value);
        },
      });
    }
    const putImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const startedAt = performance.now();
      Reflect.apply(putImageData, this, args);
      record(this.canvas, startedAt, "pixels");
    } as typeof CanvasRenderingContext2D.prototype.putImageData;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const startedAt = performance.now();
      Reflect.apply(drawImage, this, args);
      record(this.canvas, startedAt, "bitmap");
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
    const recordFrame = (at: number) => {
      state.rawSwitchFrames?.push(at);
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
  });

  const secondFixture = testInfo.outputPath("second.ARW");
  await copyFile(fixture, secondFixture);
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles([fixture, secondFixture]);
  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );
  await expect(page.getByRole("img", { name: / look$/ })).toHaveCount(27, {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: /^second\.ARW/ }).click();
  await expect(
    page.getByRole("button", { name: /second\.ARW — Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );
  await expect(page.getByRole("img", { name: / look$/ })).toHaveCount(27, {
    timeout: 60_000,
  });

  const before = await page.evaluate(() => ({
    at: performance.now(),
    decodeCount: performance.getEntriesByName("raw-alchemy:preview-worker")
      .length,
    fileReadCount: performance.getEntriesByName("raw-alchemy:file-read").length,
  }));
  await page
    .getByRole("button", { name: new RegExp(`^${fixture.split("/").at(-1)}`) })
    .click();
  await expect(
    page.getByRole("button", {
      name: new RegExp(`${fixture.split("/").at(-1)} — Ready`),
    }),
  ).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(250);
  const measurement = await page.evaluate(
    ({ fallbackStartedAt }) => {
      const state = window as Window & {
        rawSwitchStartedAt?: number;
        rawSwitchDraws?: Array<{
          at: number;
          duration: number;
          width: number;
          label: string | null;
          kind: "bitmap" | "pixels";
        }>;
        rawSwitchResizes?: Array<{ at: number; dimension: "width" | "height" }>;
        rawSwitchFrames?: number[];
        rawSwitchLongTasks?: Array<{ at: number; duration: number }>;
      };
      const startedAt = state.rawSwitchStartedAt ?? fallbackStartedAt;
      const endedAt = performance.now();
      const frames = (state.rawSwitchFrames ?? []).filter(
        (at) => at >= startedAt && at <= endedAt,
      );
      const draws = (state.rawSwitchDraws ?? []).filter(
        ({ at }) => at >= startedAt,
      );
      const firstPreviewDraw = draws.find(({ width }) => width === 1_024);
      return {
        durationMs: endedAt - startedAt,
        firstPreviewDrawMs: firstPreviewDraw
          ? firstPreviewDraw.at - startedAt
          : undefined,
        draws,
        resizes: (state.rawSwitchResizes ?? []).filter(
          ({ at }) => at >= startedAt,
        ),
        frameGaps: frames.slice(1).map((at, index) => at - frames[index]),
        longTasks: (state.rawSwitchLongTasks ?? []).filter(
          ({ at, duration }) => at <= endedAt && at + duration >= startedAt,
        ),
        decodeCount: performance.getEntriesByName("raw-alchemy:preview-worker")
          .length,
        fileReadCount: performance.getEntriesByName("raw-alchemy:file-read")
          .length,
      };
    },
    { fallbackStartedAt: before.at },
  );
  const reportPath = testInfo.outputPath("warm-raw-switch-performance.json");
  await writeFile(reportPath, `${JSON.stringify(measurement, null, 2)}\n`);
  await testInfo.attach("warm-raw-switch-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(measurement.decodeCount).toBe(before.decodeCount);
  expect(measurement.fileReadCount).toBe(before.fileReadCount);
  expect(measurement.firstPreviewDrawMs).toBeDefined();
  expect(measurement.firstPreviewDrawMs!).toBeLessThanOrEqual(150);
  expect(measurement.resizes).toHaveLength(0);
  expect(
    measurement.draws
      .filter(({ width }) => width === 1_024)
      .map(({ kind }) => kind),
  ).toEqual(["bitmap", "bitmap"]);
  expect(measurement.longTasks).toHaveLength(0);
  expect(measurement.frameGaps.length).toBeGreaterThan(0);
  expect(Math.max(...measurement.frameGaps)).toBeLessThanOrEqual(150);
});

test("progressively paints a LUT change without blocking the interface", async ({
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
      lutDraws?: Draw[];
      lutFrames?: number[];
      lutLongTasks?: Array<{ at: number; duration: number }>;
    };
    state.lutDraws = [];
    state.lutFrames = [];
    state.lutLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.lutLongTasks?.push({
          at: entry.startTime,
          duration: entry.duration,
        });
      }
    }).observe({ type: "longtask" });
    const record = (context: CanvasRenderingContext2D) => {
      const label = context.canvas.getAttribute("aria-label");
      if (label?.includes("preview")) {
        state.lutDraws?.push({
          at: performance.now(),
          label,
          width: context.canvas.width,
        });
      }
    };
    const putImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      Reflect.apply(putImageData, this, args);
      record(this);
    } as typeof CanvasRenderingContext2D.prototype.putImageData;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      Reflect.apply(drawImage, this, args);
      record(this);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
    const recordFrame = (at: number) => {
      state.lutFrames?.push(at);
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );
  const target = await page.evaluate(async () => {
    const response = await fetch("./luts/manifest.json");
    const manifest = (await response.json()) as {
      luts: Array<{ id: string; name: string }>;
    };
    return manifest.luts.find(({ id }) => id !== "fuji-classic-negative")!;
  });
  const lookCount = await page.evaluate(async () => {
    const response = await fetch("./luts/manifest.json");
    return ((await response.json()) as { luts: unknown[] }).luts.length;
  });
  await expect(page.getByRole("img", { name: / look$/ })).toHaveCount(
    lookCount,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const state = window as Window & {
      lutDraws?: Draw[];
      lutFrames?: number[];
      lutLongTasks?: Array<{ at: number; duration: number }>;
    };
    state.lutDraws = [];
    state.lutFrames = [];
    state.lutLongTasks = [];
  });

  const startedAt = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (label) =>
          ((window as Window & { lutDraws?: Draw[] }).lutDraws ?? []).some(
            (draw) => draw.label === label && draw.width === 1_024,
          ),
        `${target.name} preview`,
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled();
  const endedAt = await page.evaluate(() => performance.now());

  const measurement = await page.evaluate(
    ({ label, startedAt, endedAt }) => {
      const state = window as Window & {
        lutDraws?: Draw[];
        lutFrames?: number[];
        lutLongTasks?: Array<{ at: number; duration: number }>;
      };
      const frames = (state.lutFrames ?? []).filter(
        (at) => at >= startedAt && at <= endedAt,
      );
      return {
        draws: (state.lutDraws ?? []).filter((draw) => draw.label === label),
        frameGaps: frames.slice(1).map((at, index) => at - frames[index]),
        longTasks: (state.lutLongTasks ?? []).filter(
          ({ at, duration }) => at <= endedAt && at + duration >= startedAt,
        ),
      };
    },
    { label: `${target.name} preview`, startedAt, endedAt },
  );
  const widths = measurement.draws.map(({ width }) => width);
  const frameGapP95 = percentile(measurement.frameGaps, 0.95);
  const frameGapMax = Math.max(...measurement.frameGaps);
  const reportPath = testInfo.outputPath("lut-change-performance.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        target,
        durationMs: endedAt - startedAt,
        widths,
        frameGapP95,
        frameGapMax,
        longTasks: measurement.longTasks,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach("lut-change-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(widths[0]).toBe(256);
  expect(widths.at(-1)).toBe(1_024);
  expect(frameGapP95).toBeLessThan(100);
  expect(frameGapMax).toBeLessThan(150);
  expect(measurement.longTasks.length).toBeLessThan(3);
});

test("keeps the interface responsive while exposure is dragged on a ready RAW", async ({
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
      exposureInputDurations?: number[];
      previewUploadDurations?: number[];
      longTasks?: Array<{ at: number; duration: number }>;
    };
    state.exposureDragFrames = [];
    state.exposureDragInputs = [];
    state.exposureInputDurations = [];
    state.previewUploadDurations = [];
    state.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks?.push({
          at: entry.startTime,
          duration: entry.duration,
        });
      }
    }).observe({ type: "longtask", buffered: true });
    const putImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const startedAt = performance.now();
      Reflect.apply(putImageData, this, args);
      if (this.canvas.getAttribute("aria-label")?.includes("preview")) {
        state.previewUploadDurations?.push(performance.now() - startedAt);
      }
    } as typeof CanvasRenderingContext2D.prototype.putImageData;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args
    ) {
      const startedAt = performance.now();
      Reflect.apply(drawImage, this, args);
      if (this.canvas.getAttribute("aria-label")?.includes("preview")) {
        state.previewUploadDurations?.push(performance.now() - startedAt);
      }
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
    const recordFrame = (at: number) => {
      state.exposureDragFrames?.push(at);
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
    let inputStartedAt = 0;
    addEventListener(
      "input",
      (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === "range"
        ) {
          inputStartedAt = performance.now();
          state.exposureDragInputs?.push(performance.now());
        }
      },
      true,
    );
    addEventListener("input", (event) => {
      if (
        inputStartedAt > 0 &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "range"
      ) {
        state.exposureInputDurations?.push(performance.now() - inputStartedAt);
      }
    });
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const exposure = page.getByRole("slider", { name: "Exposure" });
  await expect(exposure).toBeVisible();
  await expect(page.getByLabel("Base preview")).toHaveAttribute(
    "width",
    "1024",
    { timeout: 60_000 },
  );
  const lookCount = await page.evaluate(async () => {
    const response = await fetch("./luts/manifest.json");
    return ((await response.json()) as { luts: unknown[] }).luts.length;
  });
  await expect(page.getByRole("img", { name: / look$/ })).toHaveCount(
    lookCount,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const state = window as Window & {
      exposureDragFrames?: number[];
      exposureDragInputs?: number[];
      exposureInputDurations?: number[];
      previewUploadDurations?: number[];
      longTasks?: Array<{ at: number; duration: number }>;
    };
    state.exposureDragFrames = [];
    state.exposureDragInputs = [];
    state.exposureInputDurations = [];
    state.previewUploadDurations = [];
    state.longTasks = [];
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
      exposureInputDurations?: number[];
      previewUploadDurations?: number[];
      longTasks?: Array<{ at: number; duration: number }>;
    };
    const frames = state.exposureDragFrames ?? [];
    const inputs = state.exposureDragInputs ?? [];
    const inputDurations = state.exposureInputDurations ?? [];
    const dragStartedAt = inputs[0];
    const dragEndedAt = inputs.at(-1);
    if (dragStartedAt === undefined || dragEndedAt === undefined) {
      throw new Error("The exposure drag produced no input events.");
    }
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
      inputDurationMax: Math.max(0, ...inputDurations),
      previewUploadDurationMax: Math.max(
        0,
        ...(state.previewUploadDurations ?? []),
      ),
      longTasks: (state.longTasks ?? []).filter(
        ({ at, duration }) =>
          at <= dragEndedAt && at + duration >= dragStartedAt,
      ),
    };
  });
  const frameGapP95 = percentile(measurement.interactionFrameGaps, 0.95);
  const frameGapMax = Math.max(...measurement.interactionFrameGaps);
  const dimensionText =
    (await page.getByLabel("Photo dimensions").textContent()) ?? "";
  const dimensions = dimensionText.match(/^(\d+)\s*×\s*(\d+)$/);
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
        inputDurationMax: measurement.inputDurationMax,
        previewUploadDurationMax: measurement.previewUploadDurationMax,
        longTasks: measurement.longTasks,
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
  if (hardwarePerformance) {
    expect(frameGapP95).toBeLessThan(25);
    expect(frameGapMax).toBeLessThan(100);
  } else {
    expect(frameGapP95).toBeLessThan(100);
    expect(frameGapMax).toBeLessThan(150);
    expect(measurement.inputDurationMax).toBeLessThan(40);
    expect(measurement.longTasks.length).toBeLessThan(3);
  }
});

async function chooseLook(page: Page, name: string) {
  return measure(page, async () => {
    await page.getByRole("button", { name, exact: true }).click();
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
