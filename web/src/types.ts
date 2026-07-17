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
  camera?: string;
  dimensions?: string;
  error?: string;
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

export interface DemosaicBenchmarkReport {
  sensor: import("./lib/onnx-demosaic").SensorImageInfo;
  sensorTimings: LibRawSensorTimings;
  demosaic:
    | import("./lib/onnx-demosaic").DemosaicResult
    | import("./lib/native-rcd").NativeRcdResult
    | import("./lib/libraw-aahd").LibRawAahdResult;
  workerTotalMs: number;
}

export interface PreviewTimings {
  libraw: LibRawDecodeTimings;
  previewSourceMs: number;
  lutLoadMs: number;
  previewColorMs: number;
  workerTotalMs: number;
}

export interface ExportTimings {
  libraw: LibRawDecodeTimings;
  rawBackend?: "libraw" | "webgpu-aahd";
  colorBackend: "cpu" | "webgpu" | "onnx";
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
  gpuValidation?: {
    sampleCount: number;
    differingSamples: number;
    samplesOverTwoCodes: number;
    maximumDifference: number;
    meanAbsoluteDifference: number;
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

export interface CameraPreview {
  fileId: string;
  jpeg: Uint8Array<ArrayBuffer>;
}

export type WorkerCommand =
  | {
      requestId: number;
      type: "clear";
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
      type: "export";
      fileId: string;
      buffer: ArrayBuffer;
      ev: number;
      lut: LutDefinition;
      colorBackend?: "cpu" | "webgpu" | "onnx";
      rawBackend?: "libraw" | "webgpu-aahd";
      validateGpu?: boolean;
    }
  | {
      requestId: number;
      type: "benchmark-demosaic";
      buffer: ArrayBuffer;
      referenceRgb16?: ArrayBuffer;
      demosaicBackend:
        | "onnx"
        | "native-wgsl"
        | "libraw-aahd-wgsl"
        | "libraw-aahd-wgsl-tiled";
      demosaicContract: "deterministic-parallel-candidate" | "libraw-parity";
      demosaicOutputStage:
        | "demosaic"
        | "identity-lut"
        | "scaled"
        | "corrected"
        | "defects"
        | "horizontal"
        | "vertical"
        | "horizontal-yuv"
        | "vertical-yuv"
        | "horizontal-homogeneity"
        | "vertical-homogeneity"
        | "chosen-directions"
        | "directions"
        | "candidate-directions"
        | "aahd"
        | "highlight"
        | "final";
      completeExport: boolean;
      librawReference: boolean;
      candidateReference: boolean;
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
      result: PreviewResult;
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
      ok: true;
      type: "demosaic-benchmark";
      result: DemosaicBenchmarkReport;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
