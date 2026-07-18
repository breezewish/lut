import createLibRaw from "./libraw/libraw.js";
import { demosaicLibRawXtransTiledWithWgsl } from "./lib/libraw-xtrans";
import type { SensorImageInfo } from "./lib/sensor-image";

/** Mounts the opt-in LibRaw-to-WebGPU X-Trans demosaic comparison. */
export function mountXtransParity(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.setAttribute("aria-label", "X-Trans RAW fixture");
  document.body.append(input);
  document.body.dataset.benchmarkStatus = "waiting";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    document.body.dataset.benchmarkStatus = "running";
    void compare(file)
      .then((report) => {
        performance.mark("raw-alchemy:xtrans-parity", { detail: report });
        document.body.dataset.benchmarkStatus = "complete";
      })
      .catch((error: unknown) => {
        document.body.dataset.benchmarkStatus = "error";
        document.body.dataset.benchmarkError =
          error instanceof Error ? error.message : String(error);
      });
  });
}

async function compare(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const module = await createLibRaw();
  const sensorRaw = new module.LibRaw();
  let info: SensorImageInfo;
  let mosaic: Uint16Array<ArrayBuffer>;
  let cbrtLut: Float32Array<ArrayBuffer>;
  try {
    sensorRaw.open(bytes, false);
    if (!sensorRaw.supportsWebGpuXtrans()) {
      throw new Error("Fixture is not a supported X-Trans RAW.");
    }
    info = sensorRaw.sensorInfo();
    mosaic = new Uint16Array(sensorRaw.sensorView(0, info.sampleCount));
    cbrtLut = new Float32Array(sensorRaw.xtransCbrtView());
  } finally {
    sensorRaw.delete();
  }

  const referenceRaw = new module.LibRaw();
  try {
    referenceRaw.open(bytes, false);
    referenceRaw.enableDemosaicCapture();
    referenceRaw.imageInfo();
    const reference = referenceRaw.demosaicView(0, info.sampleCount * 3);
    const highlightClip = Math.trunc(
      Math.min(...info.demosaicPreMultipliers.slice(0, 3)) * 65535,
    );
    let highlightPixelCount = 0;
    let offset = 0;
    let differingSamples = 0;
    let maximumDifference = 0;
    let maximumDifferenceSample = 0;
    let actualAtMaximum = 0;
    let expectedAtMaximum = 0;
    let samplesOverTwoCodes = 0;
    let firstDifferenceSample = -1;
    const differingSamplesByChannel = [0, 0, 0];
    const result = await demosaicLibRawXtransTiledWithWgsl(
      mosaic,
      info,
      cbrtLut,
      undefined,
      (band) => {
        for (let index = 0; index < band.length; index += 3) {
          if (
            reference[offset + index] > highlightClip ||
            reference[offset + index + 1] > highlightClip ||
            reference[offset + index + 2] > highlightClip
          ) {
            highlightPixelCount += 1;
          }
        }
        for (let index = 0; index < band.length; index += 1) {
          const difference = Math.abs(band[index] - reference[offset + index]);
          if (difference !== 0) {
            if (firstDifferenceSample < 0)
              firstDifferenceSample = offset + index;
            differingSamples += 1;
            differingSamplesByChannel[(offset + index) % 3] += 1;
          }
          if (difference > 2) samplesOverTwoCodes += 1;
          if (difference > maximumDifference) {
            maximumDifference = difference;
            maximumDifferenceSample = offset + index;
            actualAtMaximum = band[index];
            expectedAtMaximum = reference[offset + index];
          }
        }
        offset += band.length;
      },
      "demosaic",
    );
    if (offset !== reference.length) {
      throw new Error(`Captured ${offset} of ${reference.length} samples.`);
    }
    return {
      width: info.width,
      height: info.height,
      differingSamples,
      maximumDifference,
      maximumDifferenceSample,
      actualAtMaximum,
      expectedAtMaximum,
      samplesOverTwoCodes,
      firstDifferenceSample,
      differingSamplesByChannel,
      highlightPixelCount,
      result,
    };
  } finally {
    referenceRaw.delete();
  }
}
