export type QueueStatus =
  | "queued"
  | "decoding"
  | "ready"
  | "exporting"
  | "done"
  | "decode-error"
  | "export-error";

export interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  /** Exposure compensation applied to this photo, in EV. */
  ev: number;
  /** Selected built-in look for this photo. */
  lutId: string;
  camera?: string;
  dimensions?: string;
  error?: string;
  /** Filmstrip thumbnail (a small JPEG data URL) built from the base preview. */
  thumbUrl?: string;
}

export interface LutDefinition {
  id: string;
  group: string;
  name: string;
  file: string;
  sha256: string;
}

export interface LutManifest {
  version: number;
  contract: {
    inputGamut: string;
    inputTransfer: string;
    interpolation: string;
    outputGamut: string;
    outputTransfer: string;
    outputStatus: "verified" | "unverified";
    provenance: string;
  };
  luts: LutDefinition[];
}

export interface LibRawDecodeTimings {
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

export interface LibRawSensorTimings {
  inputCopyMs: number;
  openMs: number;
  unpackMs: number;
  mosaicCopyMs: number;
  totalMs: number;
}

export interface PreviewTimings {
  previewBackend: "webgpu";
  libraw: LibRawDecodeTimings;
  previewSourceMs: number;
  lutLoadMs: number;
  previewColorMs: number;
  workerTotalMs: number;
  gpuExecutionAndReadbackMs?: number;
}

export interface ExportTimings {
  libraw: LibRawDecodeTimings;
  rawBackend: "libraw" | "webgpu-aahd";
  colorBackend: "webgpu";
  colorProcessingMs: number;
  tiffEncodingMs: number;
  workerTotalMs: number;
  gpuInputPreparationMs?: number;
  gpuExecutionAndReadbackMs?: number;
  gpuOutputPreparationMs?: number;
  webGpuAahd?: {
    timings: import("./lib/libraw-aahd").LibRawAahdTimings;
    resources: NonNullable<
      import("./lib/libraw-aahd").LibRawAahdResult["resources"]
    >;
  };
}

export interface ExportResult {
  tiff: Uint8Array;
  timings: ExportTimings;
}

export interface PreviewResult {
  fileId: string;
  width: number;
  height: number;
  base?: Uint8Array<ArrayBuffer>;
  lut: Uint8Array<ArrayBuffer>;
  metadata: {
    camera: string;
    width: number;
    height: number;
  };
  decodeCount: number;
  timings: PreviewTimings;
}

/** Interaction-only Preview transport that keeps RGBA buffers off the UI thread. */
export interface BitmapPreviewResult
  extends Omit<PreviewResult, "base" | "lut"> {
  baseBitmap?: ImageBitmap;
  lutBitmap: ImageBitmap;
}

export type DisplayPreviewResult = PreviewResult | BitmapPreviewResult;

export interface CameraPreview {
  fileId: string;
  jpeg: Uint8Array<ArrayBuffer>;
}

export interface LookPreviewResult {
  fileId: string;
  ev: number;
  lutId: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export type WorkerCommand =
  | {
      requestId: number;
      type: "prepare-luts";
      luts: LutDefinition[];
    }
  | {
      requestId: number;
      type: "clear";
    }
  | {
      requestId: number;
      type: "activate";
      fileId: string;
    }
  | {
      requestId: number;
      type: "release";
      fileId: string;
    }
  | {
      requestId: number;
      type: "decode";
      fileId: string;
      buffer: ArrayBuffer;
      ev: number;
      lut: LutDefinition;
    }
  | {
      requestId: number;
      type: "render";
      fileId: string;
      ev: number;
      lut: LutDefinition;
      maxEdge: number;
      includeBase: boolean;
    }
  | {
      requestId: number;
      type: "render-looks";
      fileId: string;
      ev: number;
      luts: LutDefinition[];
      maxEdge: number;
    }
  | {
      requestId: number;
      type: "export";
      fileId: string;
      buffer: ArrayBuffer;
      ev: number;
      lut: LutDefinition;
    };

export type WorkerReply =
  | {
      requestId: number;
      ok: true;
      type: "cleared";
    }
  | {
      requestId: number;
      ok: true;
      type: "activated";
      cached: boolean;
    }
  | {
      requestId: number;
      ok: true;
      type: "released";
    }
  | {
      requestId: number;
      ok: true;
      type: "thumbnail";
      result: CameraPreview;
    }
  | {
      requestId: number;
      ok: true;
      type: "preview-frame";
      result: PreviewResult;
    }
  | {
      requestId: number;
      ok: true;
      type: "preview";
      result: DisplayPreviewResult;
    }
  | {
      requestId: number;
      ok: true;
      type: "look-preview";
      result: LookPreviewResult;
    }
  | {
      requestId: number;
      ok: true;
      type: "look-previews";
      fileId: string;
      completed: number;
    }
  | {
      requestId: number;
      ok: true;
      type: "export";
      fileId: string;
      tiff: Uint8Array;
      timings: ExportTimings;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
