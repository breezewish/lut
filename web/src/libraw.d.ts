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
    imageInfoRetainingDecoder(): DecodedImageInfo;
    discardImage(): void;
    imageView(offset: number, length: number): Uint16Array;
    supportsWebGpuAahd(): boolean;
    supportsWebGpuXtrans(): boolean;
    sensorInfo(): import("./lib/sensor-image").SensorImageInfo;
    captureSensorMosaic(): void;
    finishSensorInfo(): import("./lib/sensor-image").SensorImageInfo;
    sensorView(offset: number, length: number): Uint16Array;
    sensorTimings(): import("./types").LibRawSensorTimings;
    timings(): import("./types").LibRawDecodeTimings;
    thumbnailData():
      | import("./lib/embedded-thumbnail").EmbeddedThumbnail
      | undefined;
    xtransCbrtView(): Float32Array;
    usesParallelUnpack(): boolean;
    delete(): void;
  }

  class JpegEncoderInstance {
    nextStripSamples(): number;
    writeRenderedStrip(pixels: Uint16Array): void;
    finish(): Uint8Array<ArrayBuffer>;
    delete(): void;
  }

  interface LibRawModule {
    LibRaw: new () => LibRawInstance;
    JpegEncoder: new (
      width: number,
      height: number,
      quality: number,
    ) => JpegEncoderInstance;
    getExceptionMessage: (exception: unknown) => [string, string];
    decrementExceptionRefcount: (exception: unknown) => void;
  }

  export default function createModule(): Promise<LibRawModule>;
}
