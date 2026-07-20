/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import initLutify, {
  PreviewSource,
  TiffEncoder,
  WasmLut,
} from "../wasm/lutify_core.js";
import { describeProcessingError } from "../lib/errors";
import { loadLutBytes } from "../lib/lut-cache";
import {
  type GpuStripImageEncoder,
  RenderedImageStream,
  renderImageInGpuStrips,
} from "../lib/image-export";
import { demosaicLibRawAahdTiledWithWgsl } from "../lib/libraw-aahd";
import { demosaicLibRawXtransTiledWithWgsl } from "../lib/libraw-xtrans";
import type { SensorImageInfo } from "../lib/sensor-image";
import { WebGpuColorRenderer } from "../lib/webgpu-color";
import { whiteBalanceMatrix } from "../lib/white-balance";
import {
  prepareWebGpuPreview,
  WebGpuPreviewRenderer,
  WebGpuPreviewSource,
} from "../lib/webgpu-preview";
import type {
  ExportTimings,
  LibRawDecodeTimings,
  LutDefinition,
  OutputFormat,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
} from "../types";

const context: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;
const runtime = Promise.all([createLibRaw(), initLutify()]).then(
  ([module]) => ({ module }),
);
type LibRawModule = Awaited<ReturnType<typeof createLibRaw>>;
type LibRawInstance = InstanceType<LibRawModule["LibRaw"]>;
let parallelRuntime: Promise<LibRawModule> | undefined;
const previewGpuPreparation = prepareWebGpuPreview();
void previewGpuPreparation.catch(() => undefined);

type CachedPreview = {
  fileId: string;
  baseEv: number;
  metadata: PreviewResult["metadata"];
  timings: PreviewResult["timings"];
  source: WebGpuPreviewSource;
  sensor?: {
    module: LibRawModule;
    raw: LibRawInstance;
    info: SensorImageInfo;
    backend: "webgpu-aahd" | "webgpu-xtrans";
    bytes: number;
  };
};

// Every entry owns a display-sized RGB16 source and may own a bounded sensor
// mosaic for export. One renderer shares the LUT, output, and readback buffers
// because Worker commands are serialized and previews never run concurrently.
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
// Sensor mosaics accelerate full-resolution export, but unlike display-sized
// GPU sources they are large WASM allocations. Share main's 64 MiB budget
// across the six-photo Preview LRU instead of allowing 64 MiB per photo.
const SENSOR_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let sensorCacheBytes = 0;

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
      releaseAllPreviews();
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
      if (preview) releasePreview(preview);
      previewCache.delete(data.fileId);
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "released",
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "load-thumbnail") {
      const raw = new module.LibRaw();
      let found = false;
      try {
        raw.openPreview(new Uint8Array(data.buffer), PREVIEW_MAX_EDGE);
        const metadata = raw.metadata();
        const thumbnail = raw.thumbnailData();
        const jpeg = thumbnail && (await thumbnailJpeg(thumbnail));
        if (jpeg) {
          found = true;
          postThumbnail(
            data.requestId,
            data.fileId,
            jpeg,
            metadata.width,
            metadata.height,
          );
        }
      } finally {
        raw.delete();
      }
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "thumbnail-loaded",
        found,
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "decode") {
      const workerStartedAt = performance.now();
      const openedPreview = await openPreviewRaw(module, data.buffer);
      module = openedPreview.module;
      const previewRaw = openedPreview.raw;
      let preview: CachedPreview | undefined;
      let retainPreviewRaw = false;
      let sensorCache:
        | {
            backend: "webgpu-aahd" | "webgpu-xtrans";
            bytes: number;
          }
        | undefined;
      try {
        // Preview has its own display-sized decode contract. LibRaw keeps RAW
        // identification, unpack, black levels, WB, CFA handling, crop, and
        // orientation, then discards pixels that cannot reach the 1024px
        // cache before highlight and color conversion. Export never calls
        // this entry point.
        const metadata = previewRaw.metadata();
        const thumbnail = previewRaw.thumbnailData();
        const thumbnailBytes = thumbnail && (await thumbnailJpeg(thumbnail));
        if (thumbnailBytes) {
          postThumbnail(
            data.requestId,
            data.fileId,
            thumbnailBytes,
            metadata.width,
            metadata.height,
          );
        }
        const sensorBackend = previewRaw.supportsWebGpuAahd()
          ? "webgpu-aahd"
          : previewRaw.supportsWebGpuXtrans()
            ? "webgpu-xtrans"
            : undefined;
        const visibleSensorBytes = metadata.width * metadata.height * 2;
        sensorCache =
          sensorBackend &&
          visibleSensorBytes <= SENSOR_CACHE_MAX_BYTES &&
          // Copying an uncompressed mosaic costs more Preview time than its
          // later unpack saves. Retain only inputs whose file is at least 25%
          // smaller than the visible sensor, a conservative compression signal.
          data.buffer.byteLength * 4 < visibleSensorBytes * 3
            ? {
                backend: sensorBackend,
                bytes: visibleSensorBytes,
              }
            : undefined;
        if (sensorCache) previewRaw.captureSensorMosaic();
        const image = sensorCache
          ? previewRaw.imageInfoRetainingDecoder()
          : previewRaw.imageInfo();
        const libraw = previewRaw.timings();
        decodeCount += 1;
        await loadLut(data.lut);
        const previewSourceStartedAt = performance.now();
        const source = await createCachedPreviewSource(
          previewRaw,
          image.width,
          image.height,
        );
        const autoExposureStartedAt = performance.now();
        const baseEv = await source.measureAutoExposure();
        const autoExposureMs = performance.now() - autoExposureStartedAt;
        previewRaw.discardImage();
        preview = {
          fileId: data.fileId,
          baseEv,
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
            autoExposureMs,
            lutLoadMs: 0,
            previewColorMs: 0,
            workerTotalMs: 0,
          },
        };
        preview.timings.previewSourceMs =
          performance.now() - previewSourceStartedAt;
        cachePreview(preview);
        retainPreviewRaw = sensorCache !== undefined;
      } finally {
        if (!retainPreviewRaw) previewRaw.delete();
      }
      let sensorCaptured = false;
      try {
        const whiteBalance = whiteBalanceMatrix(data.whiteBalance);
        const interactive = await renderCached(
          data.fileId,
          data.ev,
          whiteBalance,
          data.lut,
          384,
          true,
        );
        interactive.timings.workerTotalMs = performance.now() - workerStartedAt;
        postPreviewFrame(data.requestId, interactive);
        const result = await renderCached(
          data.fileId,
          data.ev,
          whiteBalance,
          data.lut,
          PREVIEW_MAX_EDGE,
          true,
        );
        result.timings.workerTotalMs = performance.now() - workerStartedAt;
        await postBitmapPreview(data.requestId, result);
        if (sensorCache) {
          cacheSensor(preview!, {
            module,
            raw: previewRaw,
            info: previewRaw.finishSensorInfo(),
            ...sensorCache,
          });
          sensorCaptured = true;
        }
        return;
      } finally {
        if (sensorCache && !sensorCaptured) previewRaw.delete();
      }
    }

    if (data.type === "render") {
      const result = await renderCached(
        data.fileId,
        data.ev,
        whiteBalanceMatrix(data.whiteBalance),
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
      const whiteBalance = whiteBalanceMatrix(data.whiteBalance);
      let completed = 0;
      while (pending.length > 0) {
        if (priority !== previewPriority) break;
        const lut =
          completed === 0
            ? pending[0]
            : await Promise.race(
                pending.map((candidate) =>
                  cachedLuts.has(lutCacheKey(candidate))
                    ? Promise.resolve(candidate)
                    : prepareLutBytes(candidate).then(() => candidate),
                ),
              );
        pending.splice(
          pending.findIndex(({ id }) => id === lut.id),
          1,
        );
        const result = await renderCached(
          data.fileId,
          data.ev,
          whiteBalance,
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
            whiteBalance: data.whiteBalance,
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
    const cachedPreview = touchPreview(data.fileId);
    const baseEv =
      data.baseEv ??
      cachedPreview?.baseEv ??
      (await measureRawBaseEv(module, data.buffer));
    const effectiveEv = baseEv + data.ev;
    const whiteBalance = whiteBalanceMatrix(data.whiteBalance);
    const lut = await loadLut(data.lut);
    const cachedSensor = cachedPreview?.sensor;
    if (cachedSensor) module = cachedSensor.module;
    let exportRaw = cachedSensor?.raw ?? new module.LibRaw();
    let gpuRenderer: WebGpuColorRenderer | undefined;
    try {
      let rawBackend = cachedSensor?.backend;
      let sensor = cachedSensor?.info;
      if (!cachedSensor) {
        exportRaw.open(new Uint8Array(data.buffer), false);
        if (exportRaw.usesParallelUnpack()) {
          const parallelModule = await loadParallelLibRaw();
          const parallelRaw = new parallelModule.LibRaw();
          exportRaw.delete();
          module = parallelModule;
          exportRaw = parallelRaw;
          exportRaw.open(new Uint8Array(data.buffer), false);
        }
        rawBackend = exportRaw.supportsWebGpuAahd()
          ? "webgpu-aahd"
          : exportRaw.supportsWebGpuXtrans()
            ? "webgpu-xtrans"
            : undefined;
        if (rawBackend) sensor = exportRaw.sensorInfo();
      }
      if (rawBackend && sensor) {
        const mosaic = exportRaw.sensorView(0, sensor.sampleCount);
        gpuRenderer = await WebGpuColorRenderer.create(lut);
        const stream = new RenderedImageStream(
          createImageEncoder(module, data.format, sensor.width, sensor.height),
        );
        try {
          const demosaic =
            rawBackend === "webgpu-aahd"
              ? await demosaicLibRawAahdTiledWithWgsl(
                  mosaic,
                  sensor,
                  { renderer: gpuRenderer, ev: effectiveEv, whiteBalance },
                  (pixels) => stream.write(pixels),
                )
              : await demosaicLibRawXtransTiledWithWgsl(
                  mosaic,
                  sensor,
                  new Float32Array(exportRaw.xtransCbrtView()),
                  { renderer: gpuRenderer, ev: effectiveEv, whiteBalance },
                  (pixels) => stream.write(pixels),
                );
          const rendered = stream.finish(sensor.sampleCount * 3);
          const reply: WorkerReply = {
            requestId: data.requestId,
            ok: true,
            type: "export",
            fileId: data.fileId,
            bytes: rendered.bytes,
            baseEv,
            timings: {
              libraw: cachedSensor
                ? sensorDecodeTimings(ZERO_SENSOR_TIMINGS)
                : sensorDecodeTimings(exportRaw.sensorTimings()),
              rawBackend,
              sensorCacheHit: cachedSensor !== undefined,
              sensorCacheBytes: cachedSensor?.bytes,
              colorBackend: "webgpu",
              colorProcessingMs: demosaic.timings.colorMs,
              encodingMs: rendered.encodingMs,
              workerTotalMs: performance.now() - workerStartedAt,
              gpuExecutionAndReadbackMs: demosaic.timings.totalMs,
              webGpuDemosaic: {
                algorithm: demosaic.algorithm,
                timings: demosaic.timings,
                resources: demosaic.resources,
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
      const rendered = await renderImageInGpuStrips(
        image.sampleCount,
        (offset, length) => exportRaw.imageView(offset, length),
        createImageEncoder(module, data.format, image.width, image.height),
        gpuRenderer,
        effectiveEv,
        whiteBalance,
      );
      const timings: ExportTimings = {
        libraw: exportRaw.timings(),
        rawBackend: "libraw",
        colorBackend: "webgpu",
        colorProcessingMs: rendered.colorProcessingMs,
        encodingMs: rendered.encodingMs,
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
        bytes: rendered.bytes,
        baseEv,
        timings,
      };
      context.postMessage(reply, [rendered.bytes.buffer]);
    } finally {
      await gpuRenderer?.destroy();
      if (!cachedSensor) exportRaw.delete();
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

const JPEG_QUALITY = 95;

function createImageEncoder(
  module: LibRawModule,
  format: OutputFormat,
  width: number,
  height: number,
): GpuStripImageEncoder {
  if (format === "tiff") return new TiffEncoder(width, height);

  const encoder = new module.JpegEncoder(width, height, JPEG_QUALITY);
  return {
    next_strip_samples: () => encoder.nextStripSamples(),
    write_rendered_strip: (pixels) => encoder.writeRenderedStrip(pixels),
    finish: () => {
      try {
        return encoder.finish();
      } finally {
        encoder.delete();
      }
    },
    free: () => encoder.delete(),
  };
}

const ZERO_SENSOR_TIMINGS = {
  inputCopyMs: 0,
  openMs: 0,
  unpackMs: 0,
  mosaicCopyMs: 0,
  totalMs: 0,
} as const;

function postThumbnail(
  requestId: number,
  fileId: string,
  jpeg: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): void {
  const reply: WorkerReply = {
    requestId,
    ok: true,
    type: "thumbnail",
    result: { fileId, jpeg, width, height },
  };
  context.postMessage(reply, [jpeg.buffer]);
}

async function thumbnailJpeg(thumbnail: {
  format: "jpeg" | "bitmap" | "unknown";
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (thumbnail.format === "jpeg") return thumbnail.data;
  if (thumbnail.format !== "bitmap") return undefined;
  if (thumbnail.data.length !== thumbnail.width * thumbnail.height * 3) {
    throw new Error("The embedded camera thumbnail has invalid RGB data.");
  }
  const rgba = new Uint8ClampedArray(thumbnail.width * thumbnail.height * 4);
  for (
    let source = 0, destination = 0;
    source < thumbnail.data.length;
    source += 3, destination += 4
  ) {
    rgba[destination] = thumbnail.data[source];
    rgba[destination + 1] = thumbnail.data[source + 1];
    rgba[destination + 2] = thumbnail.data[source + 2];
    rgba[destination + 3] = 255;
  }
  const canvas = new OffscreenCanvas(thumbnail.width, thumbnail.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The embedded camera thumbnail could not be encoded.");
  }
  context.putImageData(
    new ImageData(rgba, thumbnail.width, thumbnail.height),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return new Uint8Array(await blob.arrayBuffer());
}

function releaseAllPreviews(): void {
  previewRenderer?.free();
  previewRenderer = undefined;
  previewLutId = undefined;
  for (const preview of previewCache.values()) releasePreview(preview);
  previewCache.clear();
}

function loadParallelLibRaw(): Promise<LibRawModule> {
  parallelRuntime ??= import("../libraw/threaded/libraw.js").then(
    ({ default: create }) => create(),
  );
  return parallelRuntime;
}

async function openPreviewRaw(
  module: LibRawModule,
  buffer: ArrayBuffer,
): Promise<{ module: LibRawModule; raw: LibRawInstance }> {
  let raw = new module.LibRaw();
  try {
    raw.openPreview(new Uint8Array(buffer), PREVIEW_MAX_EDGE);
    if (!raw.usesParallelUnpack()) return { module, raw };

    const parallelModule = await loadParallelLibRaw();
    const parallelRaw = new parallelModule.LibRaw();
    raw.delete();
    raw = parallelRaw;
    raw.openPreview(new Uint8Array(buffer), PREVIEW_MAX_EDGE);
    return { module: parallelModule, raw };
  } catch (error) {
    raw.delete();
    throw error;
  }
}

async function measureRawBaseEv(
  module: LibRawModule,
  buffer: ArrayBuffer,
): Promise<number> {
  const opened = await openPreviewRaw(module, buffer);
  const raw = opened.raw;
  let source: WebGpuPreviewSource | undefined;
  try {
    const image = raw.imageInfo();
    source = await createCachedPreviewSource(raw, image.width, image.height);
    return await source.measureAutoExposure();
  } finally {
    source?.free();
    raw.delete();
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
  whiteBalance: Float32Array,
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
  const preview = await previewRenderer.render(
    cached.baseEv + ev,
    whiteBalance,
    maxEdge,
    includeBase,
  );
  const previewColorMs = performance.now() - startedAt;
  return {
    fileId,
    baseEv: cached.baseEv,
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
  if (previous) releasePreview(previous);
  previewCache.delete(preview.fileId);
  previewCache.set(preview.fileId, preview);
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldestId = previewCache.keys().next().value;
    if (oldestId === undefined) return;
    releasePreview(previewCache.get(oldestId)!);
    previewCache.delete(oldestId);
  }
}

function cacheSensor(
  preview: CachedPreview,
  sensor: NonNullable<CachedPreview["sensor"]>,
): void {
  if (preview.sensor) releaseSensor(preview);
  while (sensorCacheBytes + sensor.bytes > SENSOR_CACHE_MAX_BYTES) {
    const oldest = [...previewCache.values()].find(
      (candidate) => candidate.sensor,
    );
    if (!oldest) {
      throw new Error("The sensor cache budget is smaller than its entry.");
    }
    releaseSensor(oldest);
  }
  preview.sensor = sensor;
  sensorCacheBytes += sensor.bytes;
}

function releasePreview(preview: CachedPreview): void {
  preview.source.free();
  if (preview.sensor) releaseSensor(preview);
}

function releaseSensor(preview: CachedPreview): void {
  const sensor = preview.sensor!;
  sensor.raw.delete();
  sensorCacheBytes -= sensor.bytes;
  preview.sensor = undefined;
}

async function loadLut(lut: LutDefinition): Promise<WasmLut> {
  const key = lutCacheKey(lut);
  const cachedLut = cachedLuts.get(key);
  if (cachedLut) return cachedLut;
  const bytes = await prepareLutBytes(lut);
  const parsed = new WasmLut(bytes);
  lutBytePromises.delete(key);
  cachedLuts.set(key, parsed);
  return parsed;
}

function prepareLutBytes(lut: LutDefinition): Promise<Uint8Array<ArrayBuffer>> {
  const key = lutCacheKey(lut);
  let pending = lutBytePromises.get(key);
  if (!pending) {
    pending = loadLutBytes(lut).catch((error: unknown) => {
      // A failed startup prefetch must not poison this hash for the complete
      // session. The next explicit photo attempt may run after connectivity or
      // server content has been repaired.
      lutBytePromises.delete(key);
      throw error;
    });
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
      baseEv: result.baseEv,
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
