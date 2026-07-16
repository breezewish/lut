declare module "*libraw.js" {
  interface DecodedImageInfo {
    width: number;
    height: number;
    sampleCount: number;
  }

  interface Metadata {
    width: number;
    height: number;
    camera_make: string;
    camera_model: string;
  }

  interface Thumbnail {
    width: number;
    height: number;
    format: "jpeg" | "bitmap" | "unknown";
    data: Uint8Array<ArrayBuffer>;
  }

  interface DecodeTimings {
    quality: 3 | 4 | 12;
    inputCopyMs: number;
    openMs: number;
    unpackMs: number;
    preprocessMs: number;
    demosaicMs: number;
    postprocessMs: number;
    colorConversionMs: number;
    processRemainderMs: number;
    rgb16Ms: number;
    totalMs: number;
  }

  interface AahdReferenceInfo {
    width: number;
    height: number;
    inputSampleCount: number;
    outputSampleCount: number;
    candidateSampleCount: number;
    directionSampleCount: number;
    hotPixelMs: number;
    scaleMultipliers: number[];
    preMultipliers: number[];
    yuvMatrix: number[];
    outputMatrix: number[];
    channelMinimum: number[];
    channelMaximum: number[];
  }

  class LibRawInstance {
    open(buffer: Uint8Array, halfSize: boolean): void;
    openWithQuality(
      buffer: Uint8Array,
      halfSize: boolean,
      quality: 3 | 4 | 12,
    ): void;
    metadata(): Metadata;
    imageInfo(): DecodedImageInfo;
    imageView(offset: number, length: number): Uint16Array;
    aahdReferenceInfo(): AahdReferenceInfo;
    aahdInputView(offset: number, length: number): Uint16Array;
    aahdHorizontalView(offset: number, length: number): Uint16Array;
    aahdVerticalView(offset: number, length: number): Uint16Array;
    aahdDirectionView(offset: number, length: number): Uint8Array;
    aahdOutputView(offset: number, length: number): Uint16Array;
    sensorInfo(): import("./lib/onnx-demosaic").SensorImageInfo;
    sensorView(offset: number, length: number): Uint16Array;
    sensorTimings(): import("./types").LibRawSensorTimings;
    timings(): DecodeTimings;
    thumbnailData(): Thumbnail | undefined;
    delete(): void;
  }

  interface LibRawModule {
    LibRaw: new () => LibRawInstance;
    getExceptionMessage: (exception: unknown) => [string, string];
    decrementExceptionRefcount: (exception: unknown) => void;
  }

  export default function createModule(): Promise<LibRawModule>;
}
