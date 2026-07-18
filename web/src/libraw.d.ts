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
    enableDemosaicCapture(): void;
    demosaicView(offset: number, length: number): Uint16Array;
    imageView(offset: number, length: number): Uint16Array;
    supportsWebGpuAahd(): boolean;
    supportsWebGpuXtrans(): boolean;
    sensorInfo(): import("./lib/sensor-image").SensorImageInfo;
    sensorView(offset: number, length: number): Uint16Array;
    sensorTimings(): import("./types").LibRawSensorTimings;
    timings(): import("./types").LibRawDecodeTimings;
    thumbnailData(): Thumbnail | undefined;
    xtransCbrtView(): Float32Array;
    delete(): void;
  }

  interface LibRawModule {
    LibRaw: new () => LibRawInstance;
    getExceptionMessage: (exception: unknown) => [string, string];
    decrementExceptionRefcount: (exception: unknown) => void;
  }

  export default function createModule(): Promise<LibRawModule>;
}
