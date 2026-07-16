/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import initAlchemy, { PreviewRenderer, WasmLut } from "../wasm/alchemy_core.js";
import { describeProcessingError } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { renderTiffInStrips } from "../lib/tiff-export";
import type {
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
// WebKit intermittently corrupts large typed-array WASM arguments. Pack four
// bytes per scalar call to bypass that binding path while keeping upload cheap.
const LUT_UPLOAD_WORD_BYTES = 4;

let cached:
  | {
      fileId: string;
      renderer: PreviewRenderer;
      lutId: string;
      metadata: PreviewResult["metadata"];
      timings: PreviewResult["timings"];
    }
  | undefined;
let cachedLut: { id: string; lut: WasmLut } | undefined;
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
    ({ module } = await runtime);
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
        previewRaw.open(new Uint8Array(data.buffer), true);
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
      const result = await renderCached(data.fileId, data.ev, data.lut);
      result.timings.workerTotalMs = performance.now() - workerStartedAt;
      postPreview(data.requestId, result);
      return;
    }

    if (data.type === "render") {
      postPreview(
        data.requestId,
        await renderCached(data.fileId, data.ev, data.lut),
      );
      return;
    }

    const workerStartedAt = performance.now();
    const lut = await loadLut(data.lut);
    const exportRaw = new module.LibRaw();
    try {
      exportRaw.open(new Uint8Array(data.buffer), false);
      const image = exportRaw.imageInfo();
      const rendered = renderTiffInStrips(
        image.sampleCount,
        (offset, length) => exportRaw.imageView(offset, length),
        lut.create_tiff_encoder(image.width, image.height, data.ev),
      );
      const timings = {
        libraw: exportRaw.timings() as LibRawDecodeTimings,
        colorProcessingMs: rendered.colorProcessingMs,
        deflateMs: rendered.deflateMs,
        workerTotalMs: performance.now() - workerStartedAt,
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

async function renderCached(
  fileId: string,
  ev: number,
  lut: LutDefinition,
): Promise<PreviewResult> {
  if (!cached || cached.fileId !== fileId) {
    throw new Error(
      "The selected RAW is not decoded. Select it again to retry.",
    );
  }
  const parsedLut = await loadLut(lut);
  if (cached.lutId !== lut.id) {
    parsedLut.apply_to_renderer(cached.renderer);
    cached.lutId = lut.id;
  }
  const startedAt = performance.now();
  const preview = cached.renderer.render(ev);
  const previewColorMs = performance.now() - startedAt;
  try {
    return {
      fileId,
      width: preview.width,
      height: preview.height,
      base: transferablePreviewView(preview.take_base_rgba(), "Base"),
      lut: transferablePreviewView(preview.take_lut_rgba(), "LUT"),
      metadata: cached.metadata,
      decodeCount,
      timings: { ...cached.timings, previewColorMs },
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
  if (cachedLut?.id === lut.id) return cachedLut.lut;
  const response = await fetch(`/luts/${lut.file}`);
  if (!response.ok) throw new Error(`Could not load LUT ${lut.name}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== lut.sha256)
    throw new Error(`LUT integrity check failed for ${lut.name}.`);
  const parsed = new WasmLut(bytes.length);
  let complete = false;
  try {
    const words = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    let offset = 0;
    for (
      ;
      offset + LUT_UPLOAD_WORD_BYTES <= bytes.length;
      offset += LUT_UPLOAD_WORD_BYTES
    ) {
      parsed.write_word(offset, words.getUint32(offset, true), 4);
    }
    let tail = 0;
    for (let index = offset; index < bytes.length; index += 1)
      tail |= bytes[index] << ((index - offset) * 8);
    if (offset < bytes.length)
      parsed.write_word(offset, tail, bytes.length - offset);
    parsed.finish();
    complete = true;
  } finally {
    if (!complete) parsed.free();
  }
  cachedLut?.lut.free();
  cachedLut = { id: lut.id, lut: parsed };
  return parsed;
}

function postPreview(requestId: number, result: PreviewResult): void {
  const reply: WorkerReply = { requestId, ok: true, type: "preview", result };
  context.postMessage(reply, [result.base.buffer, result.lut.buffer]);
}
