/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import { correctImmutableDefects } from "../lib/aahd-candidate-reference";
import { createLibRawYuvReference } from "../lib/aahd-parity-cpu";
import { demosaicLibRawAahdTiledValidated } from "../lib/aahd-tiled-validation";
import {
  demosaicLibRawAahdWithWgsl,
  type AahdReferenceInfo,
} from "../lib/libraw-aahd";
import type {
  DemosaicBenchmarkCommand,
  DemosaicBenchmarkReply,
} from "../demosaic-benchmark-types";

const context = self as unknown as DedicatedWorkerGlobalScope;
const runtime = createLibRaw();

context.onmessage = ({ data }: MessageEvent<DemosaicBenchmarkCommand>) => {
  void run(data);
};

async function run(data: DemosaicBenchmarkCommand): Promise<void> {
  const module = await runtime;
  const raw = new module.LibRaw();
  try {
    if (
      data.backend === "libraw-aahd-wgsl-tiled" &&
      (data.contract !== "libraw-parity" || data.outputStage !== "final")
    ) {
      throw new Error(
        "Tiled AAHD supports only the final LibRaw-parity contract.",
      );
    }
    if (
      Number(data.librawReference) +
        Number(data.candidateReference) +
        Number(data.referenceRgb16 !== undefined) >
      1
    ) {
      throw new Error("Select exactly one demosaic reference source.");
    }

    const startedAt = performance.now();
    raw.open(new Uint8Array(data.buffer), false);
    const sensor = raw.sensorInfo();
    let referenceInfo: AahdReferenceInfo | undefined;
    let reference: Uint16Array | undefined = data.referenceRgb16
      ? new Uint16Array(data.referenceRgb16)
      : undefined;
    if (data.candidateReference) {
      if (
        data.backend !== "libraw-aahd-wgsl" ||
        (data.outputStage !== "corrected" &&
          data.outputStage !== "defects" &&
          data.outputStage !== "candidate-directions")
      ) {
        throw new Error(
          "The candidate reference supports corrected, defects, and candidate-directions stages.",
        );
      }
      if (data.outputStage !== "candidate-directions") {
        referenceInfo = raw.aahdReferenceInfo();
        const input = raw.aahdInputView(0, referenceInfo.inputSampleCount);
        const candidate = correctImmutableDefects(
          input,
          referenceInfo.width,
          referenceInfo.height,
        );
        reference =
          data.outputStage === "corrected"
            ? expandScalarSamples(candidate.corrected)
            : expandDefectMask(candidate.defects, input.length);
      }
    } else if (data.librawReference) {
      referenceInfo = raw.aahdReferenceInfo();
      reference = libRawReference(raw, referenceInfo, data.outputStage);
    }

    // Capturing the LibRaw oracle can grow WASM memory and detach earlier views.
    const mosaic = raw.sensorView(0, sensor.sampleCount);
    const demosaic =
      data.backend === "libraw-aahd-wgsl-tiled"
        ? await demosaicLibRawAahdTiledValidated(mosaic, sensor, reference)
        : await demosaicLibRawAahdWithWgsl(
            mosaic,
            sensor,
            data.contract,
            data.outputStage,
            reference,
            data.outputStage === "scaled" ? undefined : referenceInfo,
          );
    const reply: DemosaicBenchmarkReply = {
      requestId: data.requestId,
      ok: true,
      report: {
        sensor,
        sensorTimings: raw.sensorTimings(),
        demosaic,
        workerTotalMs: performance.now() - startedAt,
      },
    };
    context.postMessage(reply);
  } catch (error) {
    const reply: DemosaicBenchmarkReply = {
      requestId: data.requestId,
      ok: false,
      error: describeError(error, module),
    };
    context.postMessage(reply);
  } finally {
    raw.delete();
  }
}

function libRawReference(
  raw: InstanceType<Awaited<ReturnType<typeof createLibRaw>>["LibRaw"]>,
  info: AahdReferenceInfo,
  stage: DemosaicBenchmarkCommand["outputStage"],
): Uint16Array {
  if (stage === "scaled") {
    return expandScalarSamples(raw.aahdInputView(0, info.inputSampleCount));
  }
  if (stage === "horizontal") {
    return raw.aahdHorizontalView(0, info.candidateSampleCount);
  }
  if (stage === "vertical") {
    return raw.aahdVerticalView(0, info.candidateSampleCount);
  }
  if (stage === "horizontal-yuv") {
    return createLibRawYuvReference(
      raw.aahdHorizontalView(0, info.candidateSampleCount),
      info.yuvMatrix,
    );
  }
  if (stage === "vertical-yuv") {
    return createLibRawYuvReference(
      raw.aahdVerticalView(0, info.candidateSampleCount),
      info.yuvMatrix,
    );
  }
  if (stage === "horizontal-homogeneity") {
    return expandDirections(
      raw.aahdHorizontalHomogeneityView(0, info.directionSampleCount),
    );
  }
  if (stage === "vertical-homogeneity") {
    return expandDirections(
      raw.aahdVerticalHomogeneityView(0, info.directionSampleCount),
    );
  }
  if (stage === "chosen-directions") {
    return expandDirections(
      raw.aahdChosenDirectionView(0, info.directionSampleCount),
    );
  }
  if (stage === "directions") {
    return expandDirections(
      raw.aahdDirectionView(0, info.directionSampleCount),
    );
  }
  if (stage === "aahd") {
    return raw.aahdOutputView(0, info.outputSampleCount);
  }
  if (stage === "highlight") {
    return raw.aahdHighlightView(0, info.highlightSampleCount);
  }
  return raw.imageView(0, info.outputSampleCount);
}

function expandDirections(source: Uint8Array): Uint16Array {
  const result = new Uint16Array(source.length * 3);
  for (let index = 0; index < source.length; index += 1) {
    result.fill(source[index] & 15, index * 3, index * 3 + 3);
  }
  return result;
}

function expandScalarSamples(source: Uint16Array): Uint16Array {
  const result = new Uint16Array(source.length * 3);
  for (let index = 0; index < source.length; index += 1) {
    result.fill(source[index], index * 3, index * 3 + 3);
  }
  return result;
}

function expandDefectMask(mask: Uint32Array, sampleCount: number): Uint16Array {
  const result = new Uint16Array(sampleCount * 3);
  for (let index = 0; index < sampleCount; index += 1) {
    result.fill(
      (mask[index >>> 5] >>> (index & 31)) & 1,
      index * 3,
      index * 3 + 3,
    );
  }
  return result;
}

function describeError(
  error: unknown,
  module: Awaited<ReturnType<typeof createLibRaw>>,
): string {
  if (typeof error !== "object" || error === null || !("excPtr" in error)) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    const [type, message] = module.getExceptionMessage(error);
    return `LibRaw ${type}: ${message}`;
  } finally {
    module.decrementExceptionRefcount(error);
  }
}
