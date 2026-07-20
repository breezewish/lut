import type { CameraPreview } from "../types";

export interface ThumbnailCommand {
  requestId: number;
  fileId: string;
  file: File;
}

export type ThumbnailReply =
  | { requestId: number; ok: true; result?: CameraPreview }
  | { requestId: number; ok: false; error: string };
