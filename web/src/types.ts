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

export interface PreviewResult {
  fileId: string;
  width: number;
  height: number;
  base: Uint8Array<ArrayBuffer>;
  lut: Uint8Array<ArrayBuffer>;
  metadata: {
    camera: string;
    width: number;
    height: number;
  };
  decodeCount: number;
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
      type: "thumbnail";
      result: CameraPreview;
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
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
