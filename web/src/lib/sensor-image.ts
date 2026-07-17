/** Sensor mosaic metadata required by the WebGPU AAHD implementation. */
export interface SensorImageInfo {
  width: number;
  height: number;
  sampleCount: number;
  sensorType: "bayer" | "xtrans";
  cfaSize: 2 | 6;
  cfaPattern: number[];
  blackLevels: number[];
  whiteLevel: number;
  /** Effective post-black range selected by LibRaw's AAHD scaling policy. */
  aahdScaleRange: number;
  /** Effective, normalized multipliers selected by LibRaw's WB policy. */
  aahdPreMultipliers: number[];
  cameraWhiteBalance: number[];
  xyzToCamera: number[];
  rgbCamera: number[];
  aahdYuvMatrix: number[];
  librawProPhotoMatrix: number[];
  orientation: number;
}
