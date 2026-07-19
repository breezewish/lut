/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import initAlchemy, {
  PreviewSource,
  TiffEncoder,
  WasmLut,
} from "../wasm/alchemy_core.js";
import { describeProcessingError } from "../lib/errors";
import { loadLutBytes } from "../lib/lut-cache";
import { RenderedTiffStream, renderTiffInGpuStrips } from "../lib/tiff-export";
import { demosaicLibRawAahdTiledWithWgsl } from "../lib/libraw-aahd";
import { WebGpuColorRenderer } from "../lib/webgpu-color";
import {
  prepareWebGpuPreview,
  WebGpuPreviewRenderer,
  WebGpuPreviewSource,
} from "../lib/webgpu-preview";
import type {
  ExportTimings,
  LibRawDecodeTimings,
  LutDefinition,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
} from "../types";

const context: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;
const runtime = Promise.all([createLibRaw(), initAlchemy()]).then(
  ([module]) => ({ module }),
);
const previewGpuPreparation = prepareWebGpuPreview();
void previewGpuPreparation.catch(() => undefined);

type CachedPreview = {
  fileId: string;
  metadata: PreviewResult["metadata"];
  timings: PreviewResult["timings"];
  source: WebGpuPreviewSource;
};

// Cache entries own only display-sized RGB16 sources. One renderer shares the
// LUT, output, and readback buffers across every entry because Worker commands
// are serialized and previews never execute concurrently.
const PREVIEW_CACHE_LIMIT = 6;
const previewCache = new Map<string, CachedPreview>();
const cachedLuts = new Map<string, WasmLut>();
const lutBytePromises = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
let previewRenderer: WebGpuPreviewRenderer | undefined;
let previewLutId: string | undefined;
let decodeCount = 0;

// The comparison panes are display previews, not export surfaces. A 1024px
// source keeps high-DPI UI detail while bounding every interactive Base + LUT
// rerender to 42% of the pixels used by the previous 1600px cache.
const PREVIEW_MAX_EDGE = 1_024;

let tail = Promise.resolve();
let previewPriority = 0;

context.onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  const priority =
    data.type === "render-looks" || data.type === "prepare-luts"
      ? previewPriority
      : ++previewPriority;
  tail = tail.then(
    () => handleCommand(data, priority),
    () => handleCommand(data, priority),
  );
};

async function handleCommand(
  data: WorkerCommand,
  priority: number,
): Promise<void> {
  let module: Awaited<ReturnType<typeof createLibRaw>> | undefined;
  try {
    if (data.type === "prepare-luts") {
      for (const lut of data.luts) {
        void prepareLutBytes(lut).catch(() => undefined);
      }
      return;
    }
    module = (await runtime).module;
    if (data.type === "clear") {
      previewRenderer?.free();
      previewRenderer = undefined;
      previewLutId = undefined;
      for (const preview of previewCache.values()) preview.source.free();
      previewCache.clear();
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "cleared",
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "activate") {
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "activated",
        cached: Boolean(touchPreview(data.fileId)),
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "release") {
      const preview = previewCache.get(data.fileId);
      preview?.source.free();
      previewCache.delete(data.fileId);
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "released",
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "decode") {
      const workerStartedAt = performance.now();
      const previewRaw = new module.LibRaw();
      try {
        // Preview has its own display-sized decode contract. LibRaw keeps RAW
        // identification, unpack, black levels, WB, CFA handling, crop, and
        // orientation, then discards pixels that cannot reach the 1024px
        // cache before highlight and color conversion. Export never calls
        // this entry point.
        previewRaw.openPreview(new Uint8Array(data.buffer), PREVIEW_MAX_EDGE);
        const metadata = previewRaw.metadata();
        const thumbnail = previewRaw.thumbnailData();
        if (thumbnail?.format === "jpeg") {
          const reply: WorkerReply = {
            requestId: data.requestId,
            ok: true,
            type: "thumbnail",
            result: { fileId: data.fileId, jpeg: thumbnail.data },
          };
          context.postMessage(reply, [thumbnail.data.buffer]);
        }
        const image = previewRaw.imageInfo();
        const libraw = previewRaw.timings();
        decodeCount += 1;
        await loadLut(data.lut);
        const previewSourceStartedAt = performance.now();
        const source = await createCachedPreviewSource(
          previewRaw,
          image.width,
          image.height,
        );
        const cached: CachedPreview = {
          fileId: data.fileId,
          source,
          metadata: {
            camera: [metadata.camera_make, metadata.camera_model]
              .filter(Boolean)
              .join(" "),
            width: metadata.width,
            height: metadata.height,
          },
          timings: {
            previewBackend: "webgpu",
            libraw,
            previewSourceMs: 0,
            lutLoadMs: 0,
            previewColorMs: 0,
            workerTotalMs: 0,
          },
        };
        cachePreview(cached);
        cached.timings.previewSourceMs =
          performance.now() - previewSourceStartedAt;
      } finally {
        // The GPU source now owns the display-sized RGB16 samples. Release
        // LibRaw's larger half-size image and processing state before rerenders
        // or a full-resolution export add memory pressure.
        previewRaw.delete();
      }
      const interactive = await renderCached(
        data.fileId,
        data.ev,
        data.lut,
        384,
        true,
      );
      interactive.timings.workerTotalMs = performance.now() - workerStartedAt;
      postPreviewFrame(data.requestId, interactive);
      const result = await renderCached(
        data.fileId,
        data.ev,
        data.lut,
        PREVIEW_MAX_EDGE,
        true,
      );
      result.timings.workerTotalMs = performance.now() - workerStartedAt;
      postPreview(data.requestId, result);
      return;
    }

    if (data.type === "render") {
      const result = await renderCached(
        data.fileId,
        data.ev,
        data.lut,
        data.maxEdge,
        data.includeBase,
      );
      // Interaction frames and LUT-only refinements stay as ImageBitmap all
      // the way to Canvas. The latter avoids a 1024px RGBA allocation on the
      // UI thread while the unchanged Base pane remains mounted.
      if (data.maxEdge <= 256 || !data.includeBase)
        await postBitmapPreview(data.requestId, result);
      else postPreview(data.requestId, result);
      return;
    }

    if (data.type === "render-looks") {
      const pending = [...data.luts];
      let completed = 0;
      while (pending.length > 0) {
        if (priority !== previewPriority) break;
        const lut =
          completed === 0
            ? pending[0]
            : await Promise.race(
                pending.map((candidate) =>
                  prepareLutBytes(candidate).then(() => candidate),
                ),
              );
        pending.splice(
          pending.findIndex(({ id }) => id === lut.id),
          1,
        );
        const result = await renderCached(
          data.fileId,
          data.ev,
          lut,
          data.maxEdge,
          false,
        );
        completed += 1;
        const bitmap = await rgbaBitmap(
          result.lut,
          result.width,
          result.height,
        );
        const reply: WorkerReply = {
          requestId: data.requestId,
          ok: true,
          type: "look-preview",
          result: {
            fileId: data.fileId,
            ev: data.ev,
            lutId: lut.id,
            width: result.width,
            height: result.height,
            bitmap,
          },
        };
        context.postMessage(reply, [bitmap]);
      }
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "look-previews",
        fileId: data.fileId,
        completed,
      };
      context.postMessage(reply);
      return;
    }

    const workerStartedAt = performance.now();
    const lut = await loadLut(data.lut);
    const exportRaw = new module.LibRaw();
    let gpuRenderer: WebGpuColorRenderer | undefined;
    try {
      exportRaw.open(new Uint8Array(data.buffer), false);
      if (exportRaw.supportsWebGpuAahd()) {
        const sensor = exportRaw.sensorInfo();
        const mosaic = exportRaw.sensorView(0, sensor.sampleCount);
        gpuRenderer = await WebGpuColorRenderer.create(lut);
        const stream = new RenderedTiffStream(
          new TiffEncoder(sensor.width, sensor.height),
        );
        try {
          const demosaic = await demosaicLibRawAahdTiledWithWgsl(
            mosaic,
            sensor,
            { renderer: gpuRenderer, ev: data.ev },
            (pixels) => stream.write(pixels),
          );
          const rendered = stream.finish(sensor.sampleCount * 3);
          const sensorTimings = exportRaw.sensorTimings();
          const reply: WorkerReply = {
            requestId: data.requestId,
            ok: true,
            type: "export",
            fileId: data.fileId,
            tiff: rendered.bytes,
            timings: {
              libraw: sensorDecodeTimings(sensorTimings),
              rawBackend: "webgpu-aahd",
              colorBackend: "webgpu",
              colorProcessingMs: demosaic.timings.colorMs,
              tiffEncodingMs: rendered.tiffEncodingMs,
              workerTotalMs: performance.now() - workerStartedAt,
              gpuExecutionAndReadbackMs: demosaic.timings.totalMs,
              webGpuAahd: {
                timings: demosaic.timings,
                resources: demosaic.resources!,
              },
            },
          };
          context.postMessage(reply, [rendered.bytes.buffer]);
          return;
        } finally {
          stream.free();
        }
      }

      const image = exportRaw.imageInfo();
      gpuRenderer = await WebGpuColorRenderer.create(lut);
      const rendered = await renderTiffInGpuStrips(
        image.sampleCount,
        (offset, length) => exportRaw.imageView(offset, length),
        new TiffEncoder(image.width, image.height),
        gpuRenderer,
        data.ev,
      );
      const timings: ExportTimings = {
        libraw: exportRaw.timings(),
        rawBackend: "libraw",
        colorBackend: "webgpu",
        colorProcessingMs: rendered.colorProcessingMs,
        tiffEncodingMs: rendered.tiffEncodingMs,
        workerTotalMs: performance.now() - workerStartedAt,
        gpuInputPreparationMs: rendered.gpuInputPreparationMs,
        gpuExecutionAndReadbackMs: rendered.gpuExecutionAndReadbackMs,
        gpuOutputPreparationMs: rendered.gpuOutputPreparationMs,
      };
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "export",
        fileId: data.fileId,
        tiff: rendered.bytes,
        timings,
      };
      context.postMessage(reply, [rendered.bytes.buffer]);
    } finally {
      await gpuRenderer?.destroy();
      exportRaw.delete();
    }
  } catch (error) {
    const reply: WorkerReply = {
      requestId: data.requestId,
      ok: false,
      error: module
        ? describeRuntimeError(error, module)
        : "The local processing engine could not start. Reload the page to retry.",
    };
    context.postMessage(reply);
  }
}

function sensorDecodeTimings(
  timings: import("../types").LibRawSensorTimings,
): LibRawDecodeTimings {
  return {
    quality: 12,
    inputCopyMs: timings.inputCopyMs,
    openMs: timings.openMs,
    unpackMs: timings.unpackMs,
    preprocessMs: 0,
    demosaicMs: 0,
    postprocessMs: 0,
    colorConversionMs: 0,
    previewResizeMs: 0,
    processRemainderMs: timings.mosaicCopyMs,
    rgb16Ms: 0,
    totalMs: timings.totalMs,
  };
}

function createPreviewRenderer(
  raw: InstanceType<Awaited<ReturnType<typeof createLibRaw>>["LibRaw"]>,
  width: number,
  height: number,
): PreviewSource {
  const renderer = new PreviewSource(width, height, PREVIEW_MAX_EDGE);
  const rowSamples = width * 3;
  try {
    for (;;) {
      const sourceRow = renderer.next_source_row();
      if (sourceRow === undefined) return renderer;
      const offset = sourceRow * rowSamples;
      renderer.write_source_row(raw.imageView(offset, rowSamples));
    }
  } catch (error) {
    renderer.free();
    throw error;
  }
}

async function createCachedPreviewSource(
  raw: InstanceType<Awaited<ReturnType<typeof createLibRaw>>["LibRaw"]>,
  width: number,
  height: number,
): Promise<WebGpuPreviewSource> {
  const source = createPreviewRenderer(raw, width, height);
  try {
    await previewGpuPreparation;
  } catch (error) {
    source.free();
    throw error;
  }

  const sourceWidth = source.width;
  const sourceHeight = source.height;
  let pixels: Uint16Array;
  try {
    pixels = source.take_source_rgb16();
  } finally {
    source.free();
  }
  return WebGpuPreviewSource.create(pixels, sourceWidth, sourceHeight);
}

function describeRuntimeError(
  error: unknown,
  module: Awaited<ReturnType<typeof createLibRaw>>,
): string {
  if (typeof error !== "object" || error === null || !("excPtr" in error)) {
    return describeProcessingError(error);
  }
  try {
    const [type, message] = module.getExceptionMessage(error);
    return describeProcessingError(new Error(`LibRaw ${type}: ${message}`));
  } catch {
    return describeProcessingError(error);
  } finally {
    module.decrementExceptionRefcount(error);
  }
}

async function renderCached(
  fileId: string,
  ev: number,
  lut: LutDefinition,
  maxEdge: number,
  includeBase: boolean,
): Promise<PreviewResult> {
  const workerStartedAt = performance.now();
  const cached = touchPreview(fileId);
  if (!cached) {
    throw new Error(
      "The selected RAW is not decoded. Select it again to retry.",
    );
  }
  const lutStartedAt = performance.now();
  const parsedLut = await loadLut(lut);
  const lutLoadMs = performance.now() - lutStartedAt;
  if (!previewRenderer) {
    previewRenderer = await WebGpuPreviewRenderer.create(
      cached.source,
      parsedLut,
    );
    previewLutId = lut.id;
  } else {
    previewRenderer.setSource(cached.source);
  }
  if (previewLutId !== lut.id) {
    previewRenderer.setLut(parsedLut);
    previewLutId = lut.id;
  }
  const startedAt = performance.now();
  const preview = await previewRenderer.render(ev, maxEdge, includeBase);
  const previewColorMs = performance.now() - startedAt;
  return {
    fileId,
    width: preview.width,
    height: preview.height,
    base: preview.base,
    lut: preview.lut,
    metadata: cached.metadata,
    decodeCount,
    timings: {
      ...cached.timings,
      lutLoadMs,
      previewColorMs,
      workerTotalMs: performance.now() - workerStartedAt,
      gpuExecutionAndReadbackMs: preview.executionAndReadbackMs,
    },
  };
}

function touchPreview(fileId: string): CachedPreview | undefined {
  const preview = previewCache.get(fileId);
  if (!preview) return undefined;
  previewCache.delete(fileId);
  previewCache.set(fileId, preview);
  return preview;
}

function cachePreview(preview: CachedPreview): void {
  const previous = previewCache.get(preview.fileId);
  previous?.source.free();
  previewCache.delete(preview.fileId);
  previewCache.set(preview.fileId, preview);
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldestId = previewCache.keys().next().value;
    if (oldestId === undefined) return;
    previewCache.get(oldestId)?.source.free();
    previewCache.delete(oldestId);
  }
}

async function loadLut(lut: LutDefinition): Promise<WasmLut> {
  const key = lutCacheKey(lut);
  const cachedLut = cachedLuts.get(key);
  if (cachedLut) return cachedLut;
  const bytes = await prepareLutBytes(lut);
  const parsed = new WasmLut(bytes);
  cachedLuts.set(key, parsed);
  return parsed;
}

function prepareLutBytes(lut: LutDefinition): Promise<Uint8Array<ArrayBuffer>> {
  const key = lutCacheKey(lut);
  let pending = lutBytePromises.get(key);
  if (!pending) {
    pending = loadLutBytes(lut);
    lutBytePromises.set(key, pending);
  }
  return pending;
}

function lutCacheKey(lut: LutDefinition): string {
  return `${lut.id}\n${lut.sha256}`;
}

function postPreview(requestId: number, result: PreviewResult): void {
  const reply: WorkerReply = { requestId, ok: true, type: "preview", result };
  const transfer = result.base
    ? [result.base.buffer, result.lut.buffer]
    : [result.lut.buffer];
  context.postMessage(reply, transfer);
}

async function postBitmapPreview(
  requestId: number,
  result: PreviewResult,
): Promise<void> {
  const [baseBitmap, lutBitmap] = await Promise.all([
    result.base
      ? rgbaBitmap(result.base, result.width, result.height)
      : undefined,
    rgbaBitmap(result.lut, result.width, result.height),
  ]);
  const reply: WorkerReply = {
    requestId,
    ok: true,
    type: "preview",
    result: {
      fileId: result.fileId,
      width: result.width,
      height: result.height,
      baseBitmap,
      lutBitmap,
      metadata: result.metadata,
      decodeCount: result.decodeCount,
      timings: result.timings,
    },
  };
  context.postMessage(
    reply,
    baseBitmap ? [baseBitmap, lutBitmap] : [lutBitmap],
  );
}

function postPreviewFrame(requestId: number, result: PreviewResult): void {
  const reply: WorkerReply = {
    requestId,
    ok: true,
    type: "preview-frame",
    result,
  };
  const transfer = result.base
    ? [result.base.buffer, result.lut.buffer]
    : [result.lut.buffer];
  context.postMessage(reply, transfer);
}

function rgbaBitmap(
  pixels: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const clamped = new Uint8ClampedArray(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength,
  );
  return createImageBitmap(new ImageData(clamped, width, height));
}
