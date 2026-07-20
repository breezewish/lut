import createLibRaw from "./libraw/libraw.js";
import { createSha256Hasher } from "./lib/hash";
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
        performance.mark("lutify:xtrans-parity", { detail: report });
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
  const expectedHash = new URLSearchParams(location.search).get(
    "expectedDemosaicSha256",
  );
  if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(
      "Fixture has no valid pinned LibRaw X-Trans demosaic hash.",
    );
  }
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

  const hasher = createSha256Hasher();
  const highlightClip = Math.trunc(
    Math.min(...info.demosaicPreMultipliers.slice(0, 3)) * 65535,
  );
  let highlightPixelCount = 0;
  let sampleCount = 0;
  const result = await demosaicLibRawXtransTiledWithWgsl(
    mosaic,
    info,
    cbrtLut,
    undefined,
    (band) => {
      hasher.update(
        new Uint8Array(band.buffer, band.byteOffset, band.byteLength),
      );
      for (let index = 0; index < band.length; index += 3) {
        if (
          band[index] > highlightClip ||
          band[index + 1] > highlightClip ||
          band[index + 2] > highlightClip
        ) {
          highlightPixelCount += 1;
        }
      }
      sampleCount += band.length;
    },
    "demosaic",
  );
  if (sampleCount !== info.sampleCount * 3) {
    throw new Error(
      `Rendered ${sampleCount} of ${info.sampleCount * 3} samples.`,
    );
  }
  return {
    width: info.width,
    height: info.height,
    expectedHash,
    actualHash: hasher.digestHex(),
    highlightPixelCount,
    result,
  };
}
