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
    previewResizeMs: number;
    processRemainderMs: number;
    rgb16Ms: number;
    totalMs: number;
  }

  interface AahdReferenceInfo {
    width: number;
    height: number;
    inputSampleCount: number;
    outputSampleCount: number;
    highlightSampleCount: number;
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
    openPreview(buffer: Uint8Array, maxEdge: number): void;
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
    aahdChosenDirectionView(offset: number, length: number): Uint8Array;
    aahdHorizontalHomogeneityView(offset: number, length: number): Uint8Array;
    aahdVerticalHomogeneityView(offset: number, length: number): Uint8Array;
    aahdDirectionView(offset: number, length: number): Uint8Array;
    aahdOutputView(offset: number, length: number): Uint16Array;
    aahdHighlightView(offset: number, length: number): Uint16Array;
    supportsWebGpuAahd(): boolean;
    sensorInfo(): import("./lib/sensor-image").SensorImageInfo;
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
