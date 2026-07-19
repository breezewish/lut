/** Sensor mosaic metadata required by the WebGPU demosaic implementations. */
export interface SensorImageInfo {
  width: number;
  height: number;
  sampleCount: number;
  sensorType: "bayer" | "xtrans";
  cfaSize: 2 | 6;
  cfaPattern: number[];
  blackLevels: number[];
  whiteLevel: number;
  /** Effective post-black range selected by LibRaw's scaling policy. */
  demosaicScaleRange: number;
  /** Effective, normalized multipliers selected by LibRaw's WB policy. */
  demosaicPreMultipliers: number[];
  cameraWhiteBalance: number[];
  xyzToCamera: number[];
  rgbCamera: number[];
  aahdYuvMatrix: number[];
  xtransLabMatrix: number[];
  librawProPhotoMatrix: number[];
  orientation: number;
}

/** Reproduces LibRaw's normalized pre-multipliers and scale_colors factors. */
export function calculateDemosaicScale(info: SensorImageInfo): {
  scale: Float32Array;
  pre: Float32Array;
} {
  const pre = new Float32Array(4);
  const scale = new Float32Array(4);
  for (let channel = 0; channel < 4; channel += 1) {
    pre[channel] = Math.fround(info.demosaicPreMultipliers[channel]);
    scale[channel] = Math.fround(
      Math.fround(Math.fround(pre[channel] * 65535) / info.demosaicScaleRange),
    );
  }
  return { scale, pre };
}

/** Applies one of LibRaw's float32 scale_colors factors to a sensor sample. */
export function scaleDemosaicSample(
  sample: number,
  black: number,
  scale: number,
): number {
  return Math.trunc(
    Math.min(
      65535,
      Math.max(0, Math.fround(Math.fround(sample - black) * scale)),
    ),
  );
}
