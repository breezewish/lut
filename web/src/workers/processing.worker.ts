/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import initAlchemy, {
  PreviewRenderer,
  TiffEncoder,
} from "../wasm/alchemy_core.js";
import { describeProcessingError } from "../lib/errors";
import { renderTiffInStrips } from "../lib/tiff-export";
import libRawSettings from "../libraw-settings.json";
import type {
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
    }
  | undefined;
let cachedLut: { id: string; source: string } | undefined;
let decodeCount = 0;

let tail = Promise.resolve();

context.onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  tail = tail.then(
    () => handleCommand(data),
    () => handleCommand(data),
  );
};

async function handleCommand(data: WorkerCommand): Promise<void> {
  try {
    const { module } = await runtime;
    if (data.type === "decode") {
      cached?.renderer.free();
      cached = undefined;
      const previewRaw = new module.LibRaw();
      try {
        previewRaw.open(new Uint8Array(data.buffer), decodeSettings(true));
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
        const image = previewRaw.imageData();
        if (
          image.bits !== 16 ||
          image.colors !== 3 ||
          !(image.data instanceof Uint16Array)
        ) {
          throw new Error(
            "LibRaw did not return the required 16-bit RGB image.",
          );
        }
        decodeCount += 1;
        const cube = await loadLut(data.lut);
        cached = {
          fileId: data.fileId,
          renderer: createPreviewRenderer(
            image.data,
            image.width,
            image.height,
            cube,
          ),
          lutId: data.lut.id,
          metadata: {
            camera: [metadata.camera_make, metadata.camera_model]
              .filter(Boolean)
              .join(" "),
            width: metadata.width,
            height: metadata.height,
          },
        };
      } finally {
        // The persistent Rust renderer now owns only the display-sized RGB16
        // samples. Release LibRaw's larger half-size image and processing state
        // before rerenders or a full-resolution export add memory pressure.
        previewRaw.delete();
      }
      const result = await renderCached(data.fileId, data.ev, data.lut);
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

    const cube = await loadLut(data.lut);
    const exportRaw = new module.LibRaw();
    try {
      exportRaw.open(new Uint8Array(data.buffer), decodeSettings(false));
      const image = exportRaw.imageData();
      if (
        image.bits !== 16 ||
        image.colors !== 3 ||
        !(image.data instanceof Uint16Array)
      ) {
        throw new Error("LibRaw did not return the required 16-bit RGB image.");
      }
      const tiff = renderTiffInStrips(
        image.data,
        new TiffEncoder(image.width, image.height, data.ev, cube),
      );
      const reply: WorkerReply = {
        requestId: data.requestId,
        ok: true,
        type: "export",
        fileId: data.fileId,
        tiff,
      };
      context.postMessage(reply, [tiff.buffer]);
    } finally {
      exportRaw.delete();
    }
  } catch (error) {
    const { module } = await runtime;
    const reply: WorkerReply = {
      requestId: data.requestId,
      ok: false,
      error: describeRuntimeError(error, module),
    };
    context.postMessage(reply);
  }
}

function createPreviewRenderer(
  pixels: Uint16Array,
  width: number,
  height: number,
  cube: string,
): PreviewRenderer {
  const renderer = new PreviewRenderer(width, height, 1_600, cube);
  const rowSamples = width * 3;
  try {
    for (;;) {
      const sourceRow = renderer.next_source_row();
      if (sourceRow === undefined) return renderer;
      const offset = sourceRow * rowSamples;
      renderer.write_source_row(pixels.subarray(offset, offset + rowSamples));
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

function decodeSettings(halfSize: boolean): Record<string, unknown> {
  // The wrapper applies gamma only when all six LibRaw fields are present;
  // libraw-settings.json includes the canonical four trailing zero defaults.
  return {
    ...libRawSettings,
    halfSize: Number(halfSize),
  };
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
  const cube = await loadLut(lut);
  if (cached.lutId !== lut.id) {
    cached.renderer.set_lut(cube);
    cached.lutId = lut.id;
  }
  const preview = cached.renderer.render(ev);
  try {
    return {
      fileId,
      width: preview.width,
      height: preview.height,
      base: preview.take_base_rgba(),
      lut: preview.take_lut_rgba(),
      metadata: cached.metadata,
      decodeCount,
    };
  } finally {
    preview.free();
  }
}

async function loadLut(lut: LutDefinition): Promise<string> {
  if (cachedLut?.id === lut.id) return cachedLut.source;
  const response = await fetch(`/luts/${lut.file}`);
  if (!response.ok) throw new Error(`Could not load LUT ${lut.name}.`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== lut.sha256)
    throw new Error(`LUT integrity check failed for ${lut.name}.`);
  const source = new TextDecoder().decode(bytes);
  cachedLut = { id: lut.id, source };
  return source;
}

function postPreview(requestId: number, result: PreviewResult): void {
  const reply: WorkerReply = { requestId, ok: true, type: "preview", result };
  context.postMessage(reply, [result.base.buffer, result.lut.buffer]);
}
