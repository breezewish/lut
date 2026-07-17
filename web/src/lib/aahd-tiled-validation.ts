import {
  compareRgb16,
  demosaicLibRawAahdTiledWithWgsl,
  type LibRawAahdResult,
  type TiledAahdColor,
} from "./libraw-aahd";
import type { SensorImageInfo } from "./sensor-image";

/** Captures tiled AAHD output for opt-in benchmark and parity tests. */
export async function demosaicLibRawAahdTiledValidated(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  reference?: Uint16Array,
  color?: TiledAahdColor,
): Promise<LibRawAahdResult> {
  if (!reference) {
    return demosaicLibRawAahdTiledWithWgsl(mosaic, info, color);
  }
  const captured = new Uint16Array(info.sampleCount * 3);
  let offset = 0;
  const result = await demosaicLibRawAahdTiledWithWgsl(
    mosaic,
    info,
    color,
    (band) => {
      captured.set(band, offset);
      offset += band.length;
    },
  );
  if (offset !== captured.length) {
    throw new Error(
      `Tiled AAHD captured ${offset} samples; expected ${captured.length}.`,
    );
  }
  const startedAt = performance.now();
  const validation = compareRgb16(captured, reference);
  return {
    ...result,
    timings: {
      ...result.timings,
      validationMs: performance.now() - startedAt,
    },
    validation,
  };
}
