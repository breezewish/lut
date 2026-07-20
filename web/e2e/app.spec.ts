import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

import { decodeRgb16Tiff } from "./tiff";

const linearFixture = resolve("tests/fixtures/linear.dng");
const lossyFixture = resolve("vendor/LibRaw-Wasm/test/integration/lossy.dng");
const sonyFixture = resolve("vendor/LibRaw-Wasm/example-sony.ARW");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);

test("shows an embedded camera JPEG before the processed preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    const observedWindow = window as Window & {
      cameraPreviewSeen?: boolean;
      previewGeometry?: Array<{
        cssWidth: number;
        cssHeight: number;
        pixelWidth: number;
      }>;
    };
    observedWindow.cameraPreviewSeen = false;
    observedWindow.previewGeometry = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('img[alt="Embedded camera preview"]')) {
        observedWindow.cameraPreviewSeen = true;
      }
      requestAnimationFrame(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          'canvas[aria-label="Base preview"]',
        );
        if (!canvas) return;
        const bounds = canvas.getBoundingClientRect();
        const geometry = {
          cssWidth: bounds.width,
          cssHeight: bounds.height,
          pixelWidth: canvas.width,
        };
        const previous = observedWindow.previewGeometry?.at(-1);
        if (previous?.pixelWidth !== geometry.pixelWidth) {
          observedWindow.previewGeometry?.push(geometry);
        }
      });
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["width", "height"],
      childList: true,
      subtree: true,
    });
  });

  await page.locator('input[type="file"]').setInputFiles(sonyFixture);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as Window & { cameraPreviewSeen?: boolean })
              .cameraPreviewSeen,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              previewGeometry?: Array<{ pixelWidth: number }>;
            }
          ).previewGeometry?.at(-1)?.pixelWidth,
      ),
    )
    .toBe(1_024);
  const geometry = await page.evaluate(
    () =>
      (
        window as Window & {
          previewGeometry?: Array<{ cssWidth: number; cssHeight: number }>;
        }
      ).previewGeometry ?? [],
  );
  expect(geometry.length).toBeGreaterThanOrEqual(2);
  const widths = geometry.map(({ cssWidth }) => cssWidth);
  const heights = geometry.map(({ cssHeight }) => cssHeight);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(3);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(3);
});

test("keeps canvases mounted and visible while interaction frames arrive", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      const message = args[0] as { type?: string; maxEdge?: number };
      const state = window as Window & {
        delayPreviewRenders?: boolean;
        previewRenderEdges?: number[];
      };
      if (message?.type === "render" && message.maxEdge !== undefined) {
        state.previewRenderEdges ??= [];
        state.previewRenderEdges.push(message.maxEdge);
      }
      if (state.delayPreviewRenders && message?.type === "render") {
        window.setTimeout(() => {
          Reflect.apply(originalPostMessage, this, args);
        }, 300);
        return;
      }
      return Reflect.apply(originalPostMessage, this, args);
    };
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  const basePreview = page.getByRole("img", {
    name: "Base preview",
    exact: true,
  });
  const lutPreview = page.getByLabel("Classic Negative preview");
  await expect(basePreview).toBeVisible({ timeout: 20_000 });
  await expect(lutPreview).toBeVisible();
  const processing = page.getByRole("status", {
    name: "Preview processing",
  });
  await expect(processing).toHaveCount(0);
  await expect
    .poll(() =>
      basePreview.evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.width !== 300 && canvas.height !== 150,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      lutPreview.evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.width !== 300 && canvas.height !== 150,
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const previousBase = await basePreview.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  const previousLut = await lutPreview.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  await basePreview.evaluate((canvas: HTMLCanvasElement) => {
    canvas.dataset.continuityToken = "base";
  });
  await lutPreview.evaluate((canvas: HTMLCanvasElement) => {
    canvas.dataset.continuityToken = "look";
  });

  await page.evaluate(() => {
    (window as Window & { delayPreviewRenders?: boolean }).delayPreviewRenders =
      true;
  });
  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await page.waitForTimeout(100);
  await expect(processing).toBeVisible();

  expect(await basePreview.count()).toBe(1);
  expect(await basePreview.isVisible()).toBe(true);
  expect(await lutPreview.count()).toBe(1);
  expect(await lutPreview.isVisible()).toBe(true);
  await expect(basePreview).toHaveAttribute("data-continuity-token", "base");
  await expect(lutPreview).toHaveAttribute("data-continuity-token", "look");
  // A fast interaction frame may already have replaced the old pixels. The
  // invariant is that the same canvases stay mounted and never flash blank.
  expect(
    await basePreview.evaluate(
      (canvas: HTMLCanvasElement) => canvas.toDataURL().length,
    ),
  ).toBeGreaterThan(1_000);
  expect(
    await lutPreview.evaluate(
      (canvas: HTMLCanvasElement) => canvas.toDataURL().length,
    ),
  ).toBeGreaterThan(1_000);
  await expect
    .poll(() =>
      basePreview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(previousBase);
  await expect
    .poll(() =>
      lutPreview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(previousLut);

  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled();
  await expect(processing).toHaveCount(0);
  const currentLut = await lutPreview.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  const renderCount = await page.evaluate(
    () =>
      (window as Window & { previewRenderEdges?: number[] }).previewRenderEdges
        ?.length ?? 0,
  );
  await lutPreview.evaluate((canvas: HTMLCanvasElement) => {
    canvas.dataset.continuityToken = "look";
  });
  await page.getByRole("button", { name: "PROVIA", exact: true }).click();
  await page.waitForTimeout(100);
  await expect(processing).toBeVisible();

  const proviaPreview = page.getByLabel("PROVIA preview");
  expect(await proviaPreview.count()).toBe(1);
  expect(await proviaPreview.isVisible()).toBe(true);
  await expect(proviaPreview).toHaveAttribute("data-continuity-token", "look");
  expect(
    await proviaPreview.evaluate(
      (canvas: HTMLCanvasElement) => canvas.toDataURL().length,
    ),
  ).toBeGreaterThan(1_000);
  await expect
    .poll(() =>
      proviaPreview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(currentLut);
  await expect(processing).toHaveCount(0);
  expect(
    await page.evaluate(
      (renderCount) =>
        (
          (window as Window & { previewRenderEdges?: number[] })
            .previewRenderEdges ?? []
        ).slice(renderCount),
      renderCount,
    ),
  ).toEqual([256, 1024]);
});

test("decodes, re-renders exposure, and exports a local RAW", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const requests: Array<{ method: string; url: string }> = [];
  page.on("request", (request) => {
    requests.push({ method: request.method(), url: request.url() });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Unknown camera")).toHaveCount(0);
  const comparison = page.getByRole("region", {
    name: "Base and LUT comparison",
  });
  await expect(comparison).toHaveAttribute("aria-busy", "false");
  await expect(comparison).toHaveAttribute("data-decode-count", "1");
  await expect(page.getByRole("img", { name: "Base preview" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /linear\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toHaveAttribute("data-variant", "primary");
  const baseBeforeExposure = await page
    .getByLabel("Base preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toHaveValue("1");
  await expect
    .poll(() =>
      page
        .getByLabel("Base preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(baseBeforeExposure);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  const exposureValue = page.getByRole("spinbutton", {
    name: "Exposure value",
  });
  await exposureValue.focus();
  await exposureValue.press("Control+A");
  await exposureValue.pressSequentially("-1");
  await expect(exposureValue).toHaveValue("-1");
  await expect
    .poll(() =>
      page
        .getByLabel("Base preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(baseBeforeExposure);
  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await expect(exposureValue).toHaveValue("1");
  await expect(comparison).toHaveAttribute("data-decode-count", "1");
  const exportSelected = page.getByRole("button", {
    name: "Export selected",
  });
  await expect(exportSelected).toBeEnabled();

  const classicNegativePreview = await page
    .getByLabel("Classic Negative preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.getByRole("button", { name: "PROVIA", exact: true }).click();
  await expect(page.getByLabel("PROVIA preview")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByLabel("PROVIA preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  await page
    .getByRole("button", { name: "Classic Negative", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByLabel("Classic Negative preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  const downloadPromise = page.waitForEvent("download");
  await exportSelected.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/fuji-classic-negative\.tif$/);

  const nativeOutput = test.info().outputPath("native.tif");
  await execFileAsync("cargo", [
    "run",
    "--quiet",
    "-p",
    "alchemy-cli",
    "--",
    linearFixture,
    nativeOutput,
    "--lut",
    classicNegative,
    "--ev",
    "1",
  ]);
  const browserOutput = await download.path();
  expect(browserOutput).not.toBeNull();
  const browserBytes = await readFile(browserOutput!);
  await writeFile(test.info().outputPath("browser.tif"), browserBytes);
  const browserImage = decodeRgb16Tiff(browserBytes);
  const nativeImage = decodeRgb16Tiff(await readFile(nativeOutput));
  expect([browserImage.width, browserImage.height]).toEqual([
    nativeImage.width,
    nativeImage.height,
  ]);
  let maxCodeDifference = 0;
  for (let index = 0; index < browserImage.rgb.length; index += 1) {
    maxCodeDifference = Math.max(
      maxCodeDifference,
      Math.abs(browserImage.rgb[index] - nativeImage.rgb[index]),
    );
  }
  expect(maxCodeDifference).toBeLessThanOrEqual(1);

  const applicationOrigin = new URL(page.url()).origin;
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).origin).toBe(applicationOrigin);
  }

  const droppedBytes = Array.from(await readFile(linearFixture));
  await page.getByLabel("Photo filmstrip").evaluate((queue, bytes) => {
    const transfer = new DataTransfer();
    const file = new File([new Uint8Array(bytes)], "dropped.dng", {
      lastModified: 1,
      type: "image/x-adobe-dng",
    });
    transfer.items.add(file);
    transfer.items.add(file);
    queue.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
    );
  }, droppedBytes);
  await expect(page.getByRole("button", { name: /^dropped\.dng/ })).toHaveCount(
    1,
  );
});

test("batch export produces one ZIP and corrupt input fails clearly", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    let readCount = 0;
    File.prototype.arrayBuffer = async function () {
      readCount += 1;
      if (readCount > 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      return read.call(this);
    };
  });
  const [linearBytes, lossyBytes] = await Promise.all([
    readFile(linearFixture),
    readFile(lossyFixture),
  ]);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "linear.dng",
      mimeType: "image/x-adobe-dng",
      buffer: linearBytes,
    },
    {
      name: "lossy.dng",
      mimeType: "image/x-adobe-dng",
      buffer: lossyBytes,
    },
  ]);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole("button", { name: /^lossy\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /lossy\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: "Export 2 photos" }),
  ).toHaveAttribute("data-variant", "primary");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 2 photos" }).click();
  await expect(
    page.getByRole("button", { name: "Add RAW files" }).first(),
  ).toBeDisabled();
  await expect(page.getByRole("searchbox", { name: "Look" })).toBeDisabled();
  await expect(
    page
      .getByRole("group", { name: "Built-in looks" })
      .getByRole("button")
      .first(),
  ).toBeDisabled();
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toBeDisabled();
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^linear\.dng/ }),
  ).toBeDisabled();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "raw-alchemy-fuji-classic-negative.zip",
  );
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  expect(Object.keys(archive).sort()).toEqual([
    "linear-fuji-classic-negative.tif",
    "lossy-fuji-classic-negative.tif",
  ]);
  const browserLinear = decodeRgb16Tiff(
    Buffer.from(archive["linear-fuji-classic-negative.tif"]),
  );
  const browserLossy = decodeRgb16Tiff(
    Buffer.from(archive["lossy-fuji-classic-negative.tif"]),
  );
  expect([browserLinear.width, browserLinear.height]).toEqual([64, 48]);
  expect([browserLossy.width, browserLossy.height]).toEqual([256, 168]);

  const nativeLinearPath = test.info().outputPath("batch-linear-native.tif");
  const nativeLossyPath = test.info().outputPath("batch-lossy-native.tif");
  await Promise.all([
    execFileAsync(resolve("target/release/alchemy"), [
      linearFixture,
      nativeLinearPath,
      "--lut",
      classicNegative,
      "--color",
      "never",
    ]),
    execFileAsync(resolve("target/release/alchemy"), [
      lossyFixture,
      nativeLossyPath,
      "--lut",
      classicNegative,
      "--color",
      "never",
    ]),
  ]);
  const nativeLinear = decodeRgb16Tiff(await readFile(nativeLinearPath));
  const nativeLossy = decodeRgb16Tiff(await readFile(nativeLossyPath));
  let linearMaxCodeDifference = 0;
  for (let index = 0; index < browserLinear.rgb.length; index += 1) {
    linearMaxCodeDifference = Math.max(
      linearMaxCodeDifference,
      Math.abs(browserLinear.rgb[index] - nativeLinear.rgb[index]),
    );
  }
  expect(linearMaxCodeDifference).toBeLessThanOrEqual(1);
  let lossyMaxCodeDifference = 0;
  for (let index = 0; index < browserLossy.rgb.length; index += 1) {
    lossyMaxCodeDifference = Math.max(
      lossyMaxCodeDifference,
      Math.abs(browserLossy.rgb[index] - nativeLossy.rgb[index]),
    );
  }
  expect(lossyMaxCodeDifference).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Remove linear.dng" }).click();
  await page.getByRole("button", { name: "Remove lossy.dng" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "broken.dng",
    mimeType: "image/x-adobe-dng",
    buffer: Buffer.from("not a raw file"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "The file may be damaged, or its camera format may not be supported yet.",
  );
  await expect(page.getByRole("button", { name: "Remove file" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add RAW files" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeDisabled();
});

test("batch export continues after a corrupt file without contaminating later output", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const [linearBytes, lossyBytes] = await Promise.all([
    readFile(linearFixture),
    readFile(lossyFixture),
  ]);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "before.dng",
      mimeType: "image/x-adobe-dng",
      buffer: linearBytes,
    },
    {
      name: "broken.dng",
      mimeType: "image/x-adobe-dng",
      buffer: Buffer.from("not a raw file"),
    },
    {
      name: "after.dng",
      mimeType: "image/x-adobe-dng",
      buffer: lossyBytes,
    },
  ]);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole("button", { name: /^broken\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /broken\.dng.*Failed/ }),
  ).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole("button", { name: /^after\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /after\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 2 photos" }).click();
  const download = await downloadPromise;
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  expect(Object.keys(archive).sort()).toEqual([
    "after-fuji-classic-negative.tif",
    "before-fuji-classic-negative.tif",
  ]);
  expect(
    decodeRgb16Tiff(Buffer.from(archive["before-fuji-classic-negative.tif"]))
      .width,
  ).toBe(64);
  expect(
    decodeRgb16Tiff(Buffer.from(archive["after-fuji-classic-negative.tif"]))
      .width,
  ).toBe(256);
  await expect(page.getByText("Exported 2 of 2.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /broken\.dng.*Failed/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /after\.dng.*Exported/ }),
  ).toBeVisible();
});

test("batch export stops after the active file", async ({ page }) => {
  test.setTimeout(60_000);
  const bytes = await readFile(lossyFixture);
  await page.addInitScript(() => {
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      const message = args[0] as { type?: string };
      if (message?.type === "export") {
        window.setTimeout(() => Reflect.apply(postMessage, this, args), 250);
        return;
      }
      return Reflect.apply(postMessage, this, args);
    };
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "one.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "two.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "three.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
  ]);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole("button", { name: /^two\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /two\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await page
    .getByRole("button", { name: /^three\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /three\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 3 photos" }).click();
  await page.getByRole("button", { name: /Stop after current/ }).click();

  const download = await downloadPromise;
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  const completed = Object.keys(archive).length;
  expect(completed).toBeGreaterThan(0);
  expect(completed).toBeLessThan(3);
  await expect(
    page.getByText(`Stopped after ${completed} of 3 exports.`),
  ).toBeVisible();
});

test("all built-in LUTs match optimized native RGB16 exports", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const manifest = JSON.parse(
    await readFile(resolve("assets/luts.json"), "utf8"),
  ) as {
    luts: Array<{ id: string; group: string; name: string; file: string }>;
  };
  const nativeAlchemy = resolve("target/release/alchemy");

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  for (const look of manifest.luts) {
    await page
      .getByRole("searchbox", { name: "Look" })
      .fill(`${look.group} ${look.name}`);
    await page.getByRole("button", { name: look.name, exact: true }).click();
    await expect(page.getByLabel(`${look.name} preview`)).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`linear-${look.id}.tif`);

    const nativeOutput = test.info().outputPath(`${look.id}.tif`);
    await execFileAsync(nativeAlchemy, [
      linearFixture,
      nativeOutput,
      "--lut",
      resolve("vendor/V-Log-Alchemy/Luts", look.file),
      "--ev",
      "0",
      "--color",
      "never",
    ]);
    const browserPath = await download.path();
    expect(browserPath).not.toBeNull();
    const browser = decodeRgb16Tiff(await readFile(browserPath!));
    const native = decodeRgb16Tiff(await readFile(nativeOutput));
    expect([browser.width, browser.height]).toEqual([
      native.width,
      native.height,
    ]);
    let maxCodeDifference = 0;
    for (let index = 0; index < browser.rgb.length; index += 1) {
      maxCodeDifference = Math.max(
        maxCodeDifference,
        Math.abs(browser.rgb[index] - native.rgb[index]),
      );
    }
    expect(maxCodeDifference, look.id).toBeLessThanOrEqual(1);
  }
});

test("reports a recoverable error when the local processing engine cannot start", async ({
  page,
}) => {
  await page.route("**/*.wasm*", (route) => route.abort("failed"));
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "The local processing engine could not start. Reload the page to retry.",
  );
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);
});

test("export failures retain the preview, allow retry, and release it on removal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as Window & {
      exportAttempts?: number;
      clearRequests?: number;
    };
    state.exportAttempts = 0;
    state.clearRequests = 0;

    class ExportFailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(
        command: {
          requestId: number;
          type: "clear" | "decode" | "render" | "export";
          fileId?: string;
        },
        _transfer?: Transferable[],
      ) {
        if (command.type === "clear") {
          state.clearRequests = (state.clearRequests ?? 0) + 1;
          this.reply({
            requestId: command.requestId,
            ok: true,
            type: "cleared",
          });
          return;
        }
        if (command.type === "export") {
          state.exportAttempts = (state.exportAttempts ?? 0) + 1;
          this.reply({
            requestId: command.requestId,
            ok: false,
            error: "TIFF encoding failed. Retry this file.",
          });
          return;
        }
        this.reply({
          requestId: command.requestId,
          ok: true,
          type: "preview",
          result: {
            fileId: command.fileId,
            width: 1,
            height: 1,
            base: new Uint8Array([32, 32, 32, 255]),
            lut: new Uint8Array([64, 64, 64, 255]),
            metadata: { camera: "Test Camera", width: 1, height: 1 },
            decodeCount: 1,
            timings: {
              previewBackend: "webgpu",
              libraw: {},
              previewSourceMs: 0,
              lutLoadMs: 0,
              previewColorMs: 0,
              workerTotalMs: 0,
            },
          },
        });
      }

      terminate() {}

      private reply(data: object) {
        queueMicrotask(() =>
          this.onmessage?.(new MessageEvent("message", { data })),
        );
      }
    }

    Object.defineProperty(window, "Worker", {
      value: ExportFailingWorker,
      configurable: true,
    });
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "retry.dng",
    mimeType: "image/x-adobe-dng",
    buffer: Buffer.from("test RAW"),
  });
  await expect(page.getByLabel("Base preview")).toBeVisible();

  await page.getByRole("button", { name: "Export selected" }).click();
  await expect(
    page.getByRole("button", { name: /retry\.dng.*Failed/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(
    "TIFF encoding failed. Retry this file.",
  );
  await expect(page.getByLabel("Base preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Export selected" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { exportAttempts?: number }).exportAttempts,
      ),
    )
    .toBe(2);

  await page.getByRole("button", { name: "Remove retry.dng" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { clearRequests?: number }).clearRequests,
      ),
    )
    .toBe(1);
  await expect(
    page.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();
});

test("short desktop viewports keep export in view", async ({ page }) => {
  await page.setViewportSize({ width: 1_024, height: 600 });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  const exportButton = page.getByRole("button", { name: "Export selected" });
  await expect(exportButton).toBeInViewport();
});

test("mobile empty state keeps import primary and defers processing controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "Add RAW files" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose RAW files" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("region", { name: "Processing controls" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export all" })).toHaveCount(0);
});

test("supports stable look discovery and keyboard-accessible comparison modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(sonyFixture);
  const basePreview = page.getByRole("img", {
    name: "Base preview",
    exact: true,
  });
  await expect(basePreview).toHaveAttribute("width", "1024", {
    timeout: 30_000,
  });

  await expect(page.getByRole("searchbox", { name: "Look" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Look" }).fill("PROVIA");
  await page.getByRole("button", { name: "PROVIA", exact: true }).click();
  await expect(page.getByLabel("PROVIA preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PROVIA", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  const lookPreview = page.getByRole("img", {
    name: "PROVIA preview",
    exact: true,
  });
  const comparison = page.locator(".compare");
  const divider = page.getByRole("button", {
    name: /Comparison divider/,
  });
  const before = await comparison.evaluate((element) =>
    element.style.getPropertyValue("--wipe"),
  );
  await divider.focus();
  await divider.press("ArrowRight");
  await expect
    .poll(() =>
      comparison.evaluate((element) =>
        element.style.getPropertyValue("--wipe"),
      ),
    )
    .not.toBe(before);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(comparison).toHaveClass(/is-split/);
  await expect(basePreview).toBeVisible();
  await expect(lookPreview).toBeVisible();
  await page.getByRole("button", { name: "Wipe", exact: true }).click();
  await expect(comparison).toHaveClass(/is-wipe/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(basePreview).toBeVisible();
  await expect(lookPreview).toBeVisible();

  const touchTargets = [
    page.getByRole("button", { name: /Switch to (light|dark) mode/ }),
    page.getByRole("button", { name: "Add RAW files" }).first(),
    page.getByRole("button", { name: "Wipe", exact: true }),
    page.getByRole("button", { name: "Split", exact: true }),
  ];
  for (const target of touchTargets) {
    const bounds = await target.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  for (const input of [
    page.getByRole("spinbutton", { name: "Exposure value" }),
    page.getByRole("slider", { name: "Exposure" }),
  ]) {
    expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('input[type="file"]')).toHaveAttribute(
    "tabindex",
    "-1",
  );
  expect(
    await page
      .locator(".section-heading")
      .evaluateAll((headings) =>
        headings.every((heading) => heading.scrollWidth <= heading.clientWidth),
      ),
  ).toBe(true);
});

test("workspace theme persists across reloads", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("raw-alchemy-theme", "dark");
  });
  await page.reload();

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("button", { name: "Switch to dark mode" }),
  ).toBeVisible();
});
