declare module "*libraw.js" {
  interface ProcessedImage {
    width: number;
    height: number;
    colors: number;
    bits: number;
    data: Uint8Array | Uint16Array;
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
    data: Uint8Array;
  }

  class LibRawInstance {
    open(buffer: Uint8Array, settings: Record<string, unknown>): void;
    metadata(fullOutput?: boolean): Metadata;
    imageData(): ProcessedImage;
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
