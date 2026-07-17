/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import initAlchemy, { PreviewRenderer, WasmLut } from "../wasm/alchemy_core.js";
import { describeProcessingError } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import {
  RenderedTiffStream,
  renderTiffInGpuStrips,
  renderTiffInStrips,
} from "../lib/tiff-export";
import type { RenderedTiff } from "../lib/tiff-export";
import { OnnxColorRenderer } from "../lib/onnx-color";
import { demosaicOnWebGpu } from "../lib/onnx-demosaic";
import { demosaicRcdWithNativeWgsl } from "../lib/native-rcd";
import {
  demosaicLibRawAahdWithWgsl,
  demosaicLibRawAahdTiledWithWgsl,
  type AahdReferenceInfo,
} from "../lib/libraw-aahd";
import { correctImmutableDefects } from "../lib/aahd-candidate-reference";
import { createLibRawYuvReference } from "../lib/aahd-parity-cpu";
import { WebGpuColorRenderer } from "../lib/webgpu-color";
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

let cached:
  | {
      fileId: string;
      renderer: PreviewRenderer;
      lutId: string;
      metadata: PreviewResult["metadata"];
      timings: PreviewResult["timings"];
    }
  | undefined;
const cachedLuts = new Map<string, WasmLut>();
let decodeCount = 0;

// The comparison panes are display previews, not export surfaces. A 1024px
// source keeps high-DPI UI detail while bounding every interactive Base + LUT
// rerender to 42% of the pixels used by the previous 1600px cache.
const PREVIEW_MAX_EDGE = 1_024;

let tail = Promise.resolve();

context.onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  tail = tail.then(
    () => handleCommand(data),
    () => handleCommand(data),
  );
};

async function handleCommand(data: WorkerCommand): Promise<void> {
  let module: Awaited<ReturnType<typeof createLibRaw>> | undefined;
  try {
    module = (await runtime).module;
    if (data.type === "benchmark-demosaic") {
      const workerStartedAt = performance.now();
      const raw = new module.LibRaw();
      try {
        if (
          data.demosaicBackend === "libraw-aahd-wgsl-tiled" &&
          (data.demosaicContract !== "libraw-parity" ||
            data.demosaicOutputStage !== "final")
        ) {
          throw new Error(
            "Tiled AAHD currently supports only the final LibRaw-parity contract.",
          );
        }
        raw.open(new Uint8Array(data.buffer), false);
        const sensor = raw.sensorInfo();
        if (
          Number(data.librawReference) +
            Number(data.candidateReference) +
            Number(data.referenceRgb16 !== undefined) >
          1
        ) {
          throw new Error("Select exactly one demosaic reference source.");
        }
        let referenceInfo: AahdReferenceInfo | undefined;
        let reference: Uint16Array | undefined = data.referenceRgb16
          ? new Uint16Array(data.referenceRgb16)
          : undefined;
        if (data.candidateReference) {
          if (
            data.demosaicBackend !== "libraw-aahd-wgsl" ||
            (data.demosaicOutputStage !== "corrected" &&
              data.demosaicOutputStage !== "defects" &&
              data.demosaicOutputStage !== "candidate-directions")
          ) {
            throw new Error(
              "The candidate CPU reference supports corrected, defects, and candidate-directions WGSL stages.",
            );
          }
          if (data.demosaicOutputStage !== "candidate-directions") {
            referenceInfo = raw.aahdReferenceInfo();
            const input = raw.aahdInputView(0, referenceInfo.inputSampleCount);
            const candidate = correctImmutableDefects(
              input,
              referenceInfo.width,
              referenceInfo.height,
            );
            reference =
              data.demosaicOutputStage === "corrected"
                ? expandScalarSamples(candidate.corrected)
                : expandDefectMask(candidate.defects, input.length);
          }
        } else if (data.librawReference) {
          if (
            data.demosaicBackend !== "libraw-aahd-wgsl" &&
            data.demosaicBackend !== "libraw-aahd-wgsl-tiled"
          ) {
            throw new Error("The internal LibRaw oracle requires WGSL AAHD.");
          }
          referenceInfo = raw.aahdReferenceInfo();
          reference =
            data.demosaicOutputStage === "scaled"
              ? expandScalarSamples(
                  raw.aahdInputView(0, referenceInfo.inputSampleCount),
                )
              : data.demosaicOutputStage === "horizontal"
                ? raw.aahdHorizontalView(0, referenceInfo.candidateSampleCount)
                : data.demosaicOutputStage === "vertical"
                  ? raw.aahdVerticalView(0, referenceInfo.candidateSampleCount)
                  : data.demosaicOutputStage === "horizontal-yuv"
                    ? createLibRawYuvReference(
                        raw.aahdHorizontalView(
                          0,
                          referenceInfo.candidateSampleCount,
                        ),
                        referenceInfo.yuvMatrix,
                      )
                    : data.demosaicOutputStage === "vertical-yuv"
                      ? createLibRawYuvReference(
                          raw.aahdVerticalView(
                            0,
                            referenceInfo.candidateSampleCount,
                          ),
                          referenceInfo.yuvMatrix,
                        )
                      : data.demosaicOutputStage === "horizontal-homogeneity"
                        ? expandDirections(
                            raw.aahdHorizontalHomogeneityView(
                              0,
                              referenceInfo.directionSampleCount,
                            ),
                          )
                        : data.demosaicOutputStage === "vertical-homogeneity"
                          ? expandDirections(
                              raw.aahdVerticalHomogeneityView(
                                0,
                                referenceInfo.directionSampleCount,
                              ),
                            )
                          : data.demosaicOutputStage === "chosen-directions"
                            ? expandDirections(
                                raw.aahdChosenDirectionView(
                                  0,
                                  referenceInfo.directionSampleCount,
                                ),
                              )
                            : data.demosaicOutputStage === "directions"
                              ? expandDirections(
                                  raw.aahdDirectionView(
                                    0,
                                    referenceInfo.directionSampleCount,
                                  ),
                                )
                              : data.demosaicOutputStage === "aahd"
                                ? raw.aahdOutputView(
                                    0,
                                    referenceInfo.outputSampleCount,
                                  )
                                : data.demosaicOutputStage === "highlight"
                                  ? raw.aahdHighlightView(
                                      0,
                                      referenceInfo.highlightSampleCount,
                                    )
                                  : raw.imageView(
                                      0,
                                      referenceInfo.outputSampleCount,
                                    );
        }
        // Capturing the oracle can grow WASM memory and detach earlier views.
        const mosaic = raw.sensorView(0, sensor.sampleCount);
        if (data.completeExport && data.demosaicBackend !== "native-wgsl") {
          throw new Error(
            "Complete export is currently implemented for native WGSL only.",
          );
        }
        const benchmarkEncoder = data.completeExport
          ? (await loadBenchmarkLut()).create_tiff_encoder(
              sensor.width,
              sensor.height,
              0,
            )
          : undefined;
        const demosaic =
          data.demosaicBackend === "libraw-aahd-wgsl-tiled"
            ? await demosaicLibRawAahdTiledWithWgsl(mosaic, sensor, reference)
            : data.demosaicBackend === "libraw-aahd-wgsl"
              ? await demosaicLibRawAahdWithWgsl(
                  mosaic,
                  sensor,
                  data.demosaicContract,
                  data.demosaicOutputStage === "scaled" ||
                    data.demosaicOutputStage === "corrected" ||
                    data.demosaicOutputStage === "defects" ||
                    data.demosaicOutputStage === "horizontal" ||
                    data.demosaicOutputStage === "vertical" ||
                    data.demosaicOutputStage === "horizontal-yuv" ||
                    data.demosaicOutputStage === "vertical-yuv" ||
                    data.demosaicOutputStage === "horizontal-homogeneity" ||
                    data.demosaicOutputStage === "vertical-homogeneity" ||
                    data.demosaicOutputStage === "chosen-directions" ||
                    data.demosaicOutputStage === "directions" ||
                    data.demosaicOutputStage === "candidate-directions" ||
                    data.demosaicOutputStage === "aahd" ||
                    data.demosaicOutputStage === "highlight"
                    ? data.demosaicOutputStage
                    : "final",
                  reference,
                  data.demosaicOutputStage === "scaled"
                    ? undefined
                    : referenceInfo,
                )
              : data.demosaicBackend === "native-wgsl"
                ? await demosaicRcdWithNativeWgsl(
                    mosaic,
                    sensor,
                    reference,
                    data.demosaicOutputStage === "demosaic"
                      ? "demosaic"
                      : "identity-lut",
                    benchmarkEncoder,
                  )
                : await demosaicOnWebGpu(mosaic, sensor, reference);
        const reply: WorkerReply = {
          requestId: data.requestId,
          ok: true,
          type: "demosaic-benchmark",
          result: {
            sensor,
            sensorTimings: raw.sensorTimings(),
            demosaic,
            workerTotalMs: performance.now() - workerStartedAt,
          },
        };
        context.postMessage(reply);
      } finally {
        raw.delete();
      }
      return;
    }
    if (data.type === "clear") {
      cached?.renderer.free();
      cached = undefined;
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "cleared",
      };
      context.postMessage(reply);
      return;
    }
    if (data.type === "decode") {
      const workerStartedAt = performance.now();
      cached?.renderer.free();
      cached = undefined;
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
        const libraw = previewRaw.timings() as LibRawDecodeTimings;
        decodeCount += 1;
        const lut = await loadLut(data.lut);
        const previewSourceStartedAt = performance.now();
        cached = {
          fileId: data.fileId,
          renderer: createPreviewRenderer(
            previewRaw,
            image.width,
            image.height,
            lut,
          ),
          lutId: data.lut.id,
          metadata: {
            camera: [metadata.camera_make, metadata.camera_model]
              .filter(Boolean)
              .join(" "),
            width: metadata.width,
            height: metadata.height,
          },
          timings: {
            libraw,
            previewSourceMs: 0,
            lutLoadMs: 0,
            previewColorMs: 0,
            workerTotalMs: 0,
          },
        };
        cached.timings.previewSourceMs =
          performance.now() - previewSourceStartedAt;
      } finally {
        // The persistent Rust renderer now owns only the display-sized RGB16
        // samples. Release LibRaw's larger half-size image and processing state
        // before rerenders or a full-resolution export add memory pressure.
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
      postPreview(
        data.requestId,
        await renderCached(
          data.fileId,
          data.ev,
          data.lut,
          data.maxEdge,
          data.includeBase,
        ),
      );
      return;
    }

    const workerStartedAt = performance.now();
    const lut = await loadLut(data.lut);
    const exportRaw = new module.LibRaw();
    let gpuRenderer: WebGpuColorRenderer | OnnxColorRenderer | undefined;
    try {
      if (data.rawBackend === "webgpu-aahd") {
        exportRaw.open(new Uint8Array(data.buffer), false);
        const sensor = exportRaw.sensorInfo();
        const preprocessInfo = exportRaw.aahdPreprocessInfo();
        const preprocessed = {
          corrected: exportRaw.aahdCorrectedView(0, preprocessInfo.sampleCount),
          defects: exportRaw.aahdDefectView(0, preprocessInfo.defectWordCount),
          extrema: new Uint32Array(preprocessInfo.extrema),
          totalMs: preprocessInfo.totalMs,
        };
        // Preprocessing may grow LibRaw's WASM memory. Acquire every zero-copy
        // view only after its allocations are complete so none is detached.
        const mosaic = exportRaw.sensorView(0, sensor.sampleCount);
        gpuRenderer = await WebGpuColorRenderer.create(lut);
        const stream = new RenderedTiffStream(
          lut.create_tiff_encoder(sensor.width, sensor.height, data.ev),
        );
        try {
          const demosaic = await demosaicLibRawAahdTiledWithWgsl(
            mosaic,
            sensor,
            undefined,
            undefined,
            { renderer: gpuRenderer, ev: data.ev },
            (pixels) => stream.write(pixels),
            preprocessed,
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
      exportRaw.open(new Uint8Array(data.buffer), false);
      const image = exportRaw.imageInfo();
      const colorBackend =
        data.colorBackend === "webgpu" || data.colorBackend === "onnx"
          ? data.colorBackend
          : "cpu";
      let gpuTimings: Pick<
        ExportTimings,
        | "gpuInputPreparationMs"
        | "gpuExecutionAndReadbackMs"
        | "gpuOutputPreparationMs"
        | "gpuValidation"
      > = {};
      let rendered: RenderedTiff;
      if (colorBackend !== "cpu") {
        gpuRenderer =
          colorBackend === "webgpu"
            ? await WebGpuColorRenderer.create(lut)
            : await OnnxColorRenderer.create(
                lut,
                data.ev,
                data.validateGpu === true,
              );
        const result = await renderTiffInGpuStrips(
          image.sampleCount,
          (offset, length) => exportRaw.imageView(offset, length),
          lut.create_tiff_encoder(image.width, image.height, data.ev),
          gpuRenderer,
          data.ev,
          data.validateGpu === true,
        );
        rendered = result;
        gpuTimings = {
          gpuInputPreparationMs: result.gpuInputPreparationMs,
          gpuExecutionAndReadbackMs: result.gpuExecutionAndReadbackMs,
          gpuOutputPreparationMs: result.gpuOutputPreparationMs,
          gpuValidation: result.validation,
        };
      } else {
        rendered = renderTiffInStrips(
          image.sampleCount,
          (offset, length) => exportRaw.imageView(offset, length),
          lut.create_tiff_encoder(image.width, image.height, data.ev),
        );
      }
      const timings: ExportTimings = {
        libraw: exportRaw.timings() as LibRawDecodeTimings,
        rawBackend: "libraw",
        colorBackend,
        colorProcessingMs: rendered.colorProcessingMs,
        tiffEncodingMs: rendered.tiffEncodingMs,
        workerTotalMs: performance.now() - workerStartedAt,
        ...gpuTimings,
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
  lut: WasmLut,
): PreviewRenderer {
  const renderer = lut.create_preview_renderer(width, height, PREVIEW_MAX_EDGE);
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

function expandDirections(source: Uint8Array): Uint16Array {
  const result = new Uint16Array(source.length * 3);
  for (let index = 0; index < source.length; index += 1) {
    const direction = source[index] & 15;
    result[index * 3] = direction;
    result[index * 3 + 1] = direction;
    result[index * 3 + 2] = direction;
  }
  return result;
}

function expandScalarSamples(source: Uint16Array): Uint16Array {
  const result = new Uint16Array(source.length * 3);
  for (let index = 0; index < source.length; index += 1) {
    result[index * 3] = source[index];
    result[index * 3 + 1] = source[index];
    result[index * 3 + 2] = source[index];
  }
  return result;
}

function expandDefectMask(mask: Uint32Array, sampleCount: number): Uint16Array {
  const result = new Uint16Array(sampleCount * 3);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = (mask[index >>> 5] >>> (index & 31)) & 1;
    result[index * 3] = value;
    result[index * 3 + 1] = value;
    result[index * 3 + 2] = value;
  }
  return result;
}

async function renderCached(
  fileId: string,
  ev: number,
  lut: LutDefinition,
  maxEdge: number,
  includeBase: boolean,
): Promise<PreviewResult> {
  const workerStartedAt = performance.now();
  if (!cached || cached.fileId !== fileId) {
    throw new Error(
      "The selected RAW is not decoded. Select it again to retry.",
    );
  }
  const lutStartedAt = performance.now();
  const parsedLut = await loadLut(lut);
  const lutLoadMs = performance.now() - lutStartedAt;
  if (cached.lutId !== lut.id) {
    parsedLut.apply_to_renderer(cached.renderer);
    cached.lutId = lut.id;
  }
  const startedAt = performance.now();
  const preview = cached.renderer.render(ev, maxEdge, includeBase);
  const previewColorMs = performance.now() - startedAt;
  try {
    return {
      fileId,
      width: preview.width,
      height: preview.height,
      base: includeBase
        ? transferablePreviewView(preview.take_base_rgba(), "Base")
        : undefined,
      lut: transferablePreviewView(preview.take_lut_rgba(), "LUT"),
      metadata: cached.metadata,
      decodeCount,
      timings: {
        ...cached.timings,
        lutLoadMs,
        previewColorMs,
        workerTotalMs: performance.now() - workerStartedAt,
      },
    };
  } finally {
    preview.free();
  }
}

function transferablePreviewView(
  bytes: Uint8Array,
  label: string,
): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) {
    throw new Error(`${label} preview returned unsupported shared memory.`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function loadLut(lut: LutDefinition): Promise<WasmLut> {
  const cachedLut = cachedLuts.get(lut.id);
  if (cachedLut) return cachedLut;
  const response = await fetch(`${import.meta.env.BASE_URL}luts/${lut.file}`);
  if (!response.ok) throw new Error(`Could not load LUT ${lut.name}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== lut.sha256)
    throw new Error(`LUT integrity check failed for ${lut.name}.`);
  const parsed = new WasmLut(bytes);
  cachedLuts.set(lut.id, parsed);
  return parsed;
}

async function loadBenchmarkLut(): Promise<WasmLut> {
  const response = await fetch(`${import.meta.env.BASE_URL}luts/manifest.json`);
  if (!response.ok) throw new Error("Could not load the LUT manifest.");
  const manifest = (await response.json()) as { luts: LutDefinition[] };
  const lut = manifest.luts[0];
  if (!lut) throw new Error("The LUT manifest is empty.");
  return loadLut(lut);
}

function postPreview(requestId: number, result: PreviewResult): void {
  const reply: WorkerReply = { requestId, ok: true, type: "preview", result };
  const transfer = result.base
    ? [result.base.buffer, result.lut.buffer]
    : [result.lut.buffer];
  context.postMessage(reply, transfer);
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
