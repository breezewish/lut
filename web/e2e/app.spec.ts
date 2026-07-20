import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

import { decodeRgb16Tiff } from "./tiff";

const linearFixture = resolve("tests/fixtures/linear.dng");
const leicaFixture = resolve("tests/fixtures/leica-m8.dng");
const lossyFixture = resolve("vendor/LibRaw-Wasm/test/integration/lossy.dng");
const sonyFixture = resolve("vendor/LibRaw-Wasm/example-sony.ARW");
const nikonHighEfficiencyFixture = resolve(
  "tests/fixtures/nikon-z8-high-efficiency-low.NEF",
);
const goproFixture = resolve("tests/fixtures/gopro-hero7.gpr");
const sigmaFixture = resolve("tests/fixtures/sigma-dp1.X3F");
const classicNegative = resolve(
  "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube",
);
const execFileAsync = promisify(execFile);

function firstJpegQuantizationTable(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("JPEG start-of-image marker is missing");
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xdb) {
      const precision = bytes[offset + 2] >> 4;
      if (precision !== 0) throw new Error("Expected an 8-bit JPEG table");
      return bytes.slice(offset + 3, offset + 67);
    }
    offset += length;
  }
  throw new Error("JPEG quantization table is missing");
}

function setDngOrientation(bytes: Buffer, orientation: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = String.fromCharCode(bytes[0], bytes[1]) === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (view.getUint16(entryOffset, littleEndian) === 274) {
      view.setUint16(entryOffset + 8, orientation, littleEndian);
      return;
    }
  }
  throw new Error("DNG fixture has no Orientation tag");
}

test("identifies the application as LUTify", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("LUTify");
  await expect(page.getByRole("heading", { name: "LUTify" })).toBeVisible();
});

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

test("shows portrait photos vertically in the filmstrip and Look catalog", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const portrait = Buffer.from(await readFile(leicaFixture));
  setDngOrientation(portrait, 6);

  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "portrait.dng",
    mimeType: "image/x-adobe-dng",
    buffer: portrait,
  });
  const photo = page.locator(".photo-wrap", {
    has: page.getByRole("button", { name: /portrait\.dng — Ready/ }),
  });
  const look = page.locator(".look__thumb").first();
  await expect(photo).toHaveAttribute("data-orientation", "portrait", {
    timeout: 30_000,
  });
  await expect(page.locator(".looks__catalog")).toHaveAttribute(
    "data-orientation",
    "portrait",
  );

  const photoBox = await photo.boundingBox();
  const lookBox = await look.boundingBox();
  expect(photoBox).not.toBeNull();
  expect(lookBox).not.toBeNull();
  expect(photoBox!.height).toBeGreaterThan(photoBox!.width);
  expect(lookBox!.height).toBeGreaterThan(lookBox!.width);
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
  const lutPreview = page.getByLabel("NC | Classic Neg. preview");
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
    page.getByRole("button", { name: "Export selected as TIFF" }),
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
  await page.getByRole("button", { name: "STD | Provia", exact: true }).click();
  await page.waitForTimeout(100);
  await expect(processing).toBeVisible();

  const proviaPreview = page.getByLabel("STD | Provia preview");
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
    page.getByRole("button", { name: "Export selected as TIFF" }),
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
    name: "Export selected as TIFF",
  });
  await expect(exportSelected).toBeEnabled();

  const classicNegativePreview = await page
    .getByLabel("NC | Classic Neg. preview")
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.getByRole("button", { name: "STD | Provia", exact: true }).click();
  await expect(page.getByLabel("STD | Provia preview")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByLabel("STD | Provia preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  await page
    .getByRole("button", { name: "NC | Classic Neg.", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByLabel("NC | Classic Neg. preview")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .toBe(classicNegativePreview);
  await expect(comparison).toHaveAttribute("data-decode-count", "1");

  const downloadPromise = page.waitForEvent("download");
  await exportSelected.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/fuji-classic-negative\.tif$/);
  const effectiveEv = await page.evaluate(
    () =>
      (
        performance
          .getEntriesByName("lutify:export-worker")
          .at(-1) as PerformanceMark
      ).detail.effectiveEv as number,
  );
  expect(Number.isFinite(effectiveEv)).toBe(true);

  const nativeOutput = test.info().outputPath("native.tif");
  await execFileAsync("cargo", [
    "run",
    "--quiet",
    "-p",
    "lutify-cli",
    "--",
    linearFixture,
    nativeOutput,
    "--lut",
    classicNegative,
    "--ev",
    String(effectiveEv),
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

test("exports a full-resolution Quality 95 JPEG", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  await page
    .getByRole("slider", { name: "White balance temperature" })
    .fill("42");
  await page.getByRole("slider", { name: "White balance tint" }).fill("-58");
  await page.getByLabel("Export format").selectOption("jpeg");
  const exportButton = page.getByRole("button", {
    name: "Export selected as JPEG",
  });
  await expect(exportButton).toHaveText("Export JPEG");

  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/fuji-classic-negative\.jpg$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));

  const dimensions = await page.evaluate(async (jpeg) => {
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
    );
    const result = [bitmap.width, bitmap.height];
    bitmap.close();
    return result;
  }, Array.from(bytes));
  expect(dimensions[0]).toBeGreaterThan(0);
  expect(dimensions[1]).toBeGreaterThan(0);

  const luminanceTable = firstJpegQuantizationTable(bytes);
  expect(luminanceTable[0]).toBe(2);
  expect(Math.max(...luminanceTable)).toBe(12);
  await expect(page.getByText("Exported 1 of 1 as JPEG.")).toBeVisible();
});

test("batch export applies JPEG to every ZIP entry", async ({ page }) => {
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
  const format = page.getByLabel("Export format");
  await format.selectOption("jpeg");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 2 photos as JPEG" }).click();
  await expect(format).toBeDisabled();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  expect(Object.keys(archive).sort()).toEqual([
    "linear-fuji-classic-negative.jpg",
    "lossy-fuji-classic-negative.jpg",
  ]);
  for (const bytes of Object.values(archive)) {
    expect(bytes.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(bytes.subarray(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
  }
  await expect(page.getByText("Exported 2 of 2 as JPEG.")).toBeVisible();
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
    page.getByRole("button", { name: "Export 2 photos as TIFF" }),
  ).toHaveAttribute("data-variant", "primary");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 2 photos as TIFF" }).click();
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
  expect(download.suggestedFilename()).toBe("lutify-fuji-classic-negative.zip");
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
  const [linearEffectiveEv, lossyEffectiveEv] = await page.evaluate(() =>
    performance
      .getEntriesByName("lutify:export-worker")
      .slice(-2)
      .map((entry) => (entry as PerformanceMark).detail.effectiveEv as number),
  );

  const nativeLinearPath = test.info().outputPath("batch-linear-native.tif");
  const nativeLossyPath = test.info().outputPath("batch-lossy-native.tif");
  await Promise.all([
    execFileAsync(resolve("target/release/lutify"), [
      linearFixture,
      nativeLinearPath,
      "--lut",
      classicNegative,
      "--ev",
      String(linearEffectiveEv),
      "--color",
      "never",
    ]),
    execFileAsync(resolve("target/release/lutify"), [
      lossyFixture,
      nativeLossyPath,
      "--lut",
      classicNegative,
      "--ev",
      String(lossyEffectiveEv),
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
    page.getByRole("button", { name: "Export selected as TIFF" }),
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
  await page.getByRole("button", { name: "Export 2 photos as TIFF" }).click();
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
  await expect(page.getByText("Exported 2 of 2 as TIFF.")).toBeVisible();
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
  await page.getByRole("button", { name: "Export 3 photos as TIFF" }).click();
  await page.getByRole("button", { name: /Stop after current/ }).click();

  const download = await downloadPromise;
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  const completed = Object.keys(archive).length;
  expect(completed).toBeGreaterThan(0);
  expect(completed).toBeLessThan(3);
  await expect(
    page.getByText(`Stopped after ${completed} of 3 TIFF exports.`),
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
  const nativeLutify = resolve("target/release/lutify");

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
    await page.getByRole("button", { name: "Export selected as TIFF" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`linear-${look.id}.tif`);
    const effectiveEv = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("lutify:export-worker")
            .at(-1) as PerformanceMark
        ).detail.effectiveEv as number,
    );

    const nativeOutput = test.info().outputPath(`${look.id}.tif`);
    await execFileAsync(nativeLutify, [
      linearFixture,
      nativeOutput,
      "--lut",
      resolve("vendor/V-Log-Alchemy/Luts", look.file),
      "--ev",
      String(effectiveEv),
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

test("explains Nikon High Efficiency RAW recovery options", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles(nikonHighEfficiencyFixture);

  const dialog = page.getByRole("dialog", {
    name: "Nikon High Efficiency RAW is not supported",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Adobe Lightroom / Photoshop");
  await expect(dialog).toContainText("Lossless Compression");
  await expect(
    dialog.getByRole("link", { name: "Get Adobe DNG Converter" }),
  ).toHaveAttribute(
    "href",
    "https://helpx.adobe.com/camera-raw/digital-negative.html",
  );

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: /nikon-z8-high-efficiency-low\.NEF.*Failed/,
    }),
  ).toBeVisible();
});

test("decodes and exports a Sigma X3F photo", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(sigmaFixture);

  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("SIGMA DP1")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected as TIFF" }).click();
  const download = await downloadPromise;
  const output = await download.path();
  expect(output).not.toBeNull();
  expect((await readFile(output!)).byteLength).toBeGreaterThan(1_000_000);
});

test("explains why GoPro GPR cannot be decoded", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(goproFixture);

  const dialog = page.getByRole("dialog", {
    name: "GoPro GPR is not supported",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("VC-5 compression");
  await expect(dialog).toContainText("Adobe Lightroom / Photoshop");
});

test("explains how to avoid unsupported JPEG XL DNG compression", async ({
  page,
}) => {
  const jpegXlDng = Buffer.from(await readFile(linearFixture));
  const view = new DataView(
    jpegXlDng.buffer,
    jpegXlDng.byteOffset,
    jpegXlDng.byteLength,
  );
  const firstIfd = view.getUint32(4, true);
  const entryCount = view.getUint16(firstIfd, true);
  let compressionEntry = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = firstIfd + 2 + index * 12;
    if (view.getUint16(entry, true) === 259) compressionEntry = entry;
  }
  expect(compressionEntry).toBeGreaterThan(0);
  view.setUint16(compressionEntry + 8, 52_546, true);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "jpeg-xl.dng",
    mimeType: "image/x-adobe-dng",
    buffer: jpegXlDng,
  });

  const dialog = page.getByRole("dialog", {
    name: "JPEG XL–compressed DNG is not supported",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("stores its RAW image with JPEG XL");
  await expect(dialog).toContainText("JPEG Lossless (Most Compatible)");
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
            baseEv: 1.25,
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
              autoExposureMs: 0,
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

  await page.getByRole("button", { name: "Export selected as TIFF" }).click();
  await expect(
    page.getByRole("button", { name: /retry\.dng.*Failed/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(
    "TIFF encoding failed. Retry this file.",
  );
  await expect(page.getByLabel("Base preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export selected as TIFF" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Export selected as TIFF" }).click();
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

  const exportButton = page.getByRole("button", {
    name: "Export selected as TIFF",
  });
  await expect(
    page.getByRole("slider", { name: "White balance temperature" }),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "White balance tint" }),
  ).toBeVisible();
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
  await page.getByRole("searchbox", { name: "Look" }).fill("STD");
  await page.getByRole("button", { name: "STD | Provia", exact: true }).click();
  await expect(page.getByLabel("STD | Provia preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "STD | Provia", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  const lookPreview = page.getByRole("img", {
    name: "STD | Provia preview",
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
    page.getByRole("spinbutton", {
      name: "White balance temperature value",
    }),
    page.getByRole("slider", { name: "White balance temperature" }),
    page.getByRole("spinbutton", { name: "White balance tint value" }),
    page.getByRole("slider", { name: "White balance tint" }),
  ]) {
    expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeVisible();
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
    localStorage.setItem("lutify-theme", "dark");
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
