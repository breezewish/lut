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
