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
    metadata(): Metadata;
    imageInfo(): DecodedImageInfo;
    imageView(offset: number, length: number): Uint16Array;
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
