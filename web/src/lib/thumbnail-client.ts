import type { CameraPreview } from "../types";
import type { ThumbnailCommand, ThumbnailReply } from "./thumbnail-protocol";

interface PendingThumbnail {
  resolve: (result: CameraPreview | undefined) => void;
  reject: (error: Error) => void;
}

const WORKER_IDLE_TIMEOUT_MS = 1_000;

export class ThumbnailCancelledError extends Error {
  constructor() {
    super("Thumbnail extraction was cancelled.");
    this.name = "ThumbnailCancelledError";
  }
}

/** Runs embedded-thumbnail extraction outside the interactive processing queue. */
export class ThumbnailClient {
  private worker?: Worker;
  private readonly pending = new Map<number, PendingThumbnail>();
  private nextRequestId = 1;
  private releaseTimer?: number;
  private disposed = false;

  load(fileId: string, file: File): Promise<CameraPreview | undefined> {
    if (this.disposed) {
      return Promise.reject(new Error("Thumbnail client disposed."));
    }
    if (this.releaseTimer !== undefined) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    const worker = this.worker ?? this.startWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        worker.postMessage({
          requestId,
          fileId,
          file,
        } satisfies ThumbnailCommand);
      } catch (error) {
        this.pending.delete(requestId);
        this.releaseWorkerWhenIdle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Stops background extraction immediately so interactive work gets priority. */
  cancel(): void {
    if (!this.worker) return;
    this.stopWorker(new ThumbnailCancelledError());
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker(new Error("Thumbnail client disposed."));
  }

  private startWorker(): Worker {
    const worker = new Worker(
      new URL("../workers/thumbnail.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = ({ data }: MessageEvent<ThumbnailReply>) => {
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error));
      this.releaseWorkerWhenIdle();
    };
    worker.onerror = (event) => {
      const error = new Error(
        event.message || "The thumbnail worker stopped unexpectedly.",
      );
      this.stopWorker(error);
    };
    this.worker = worker;
    return worker;
  }

  private releaseWorkerWhenIdle(): void {
    if (this.pending.size > 0 || !this.worker) return;
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = undefined;
      this.worker?.terminate();
      this.worker = undefined;
    }, WORKER_IDLE_TIMEOUT_MS);
  }

  private stopWorker(error: Error): void {
    if (this.releaseTimer !== undefined) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
