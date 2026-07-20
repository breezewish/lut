import type {
  CameraPreview,
  DisplayPreviewResult,
  ExportResult,
  LookPreviewResult,
  LutDefinition,
  OutputFormat,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
  WhiteBalanceValues,
} from "../types";

type Pending = {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
};

type PreviewPending = {
  resolve: (result: DisplayPreviewResult) => void;
  reject: (error: Error) => void;
};

type RenderBatch = {
  fileId: string;
  ev: number;
  whiteBalance: WhiteBalanceValues;
  lut: LutDefinition;
  maxEdge: number;
  includeBase: boolean;
  pending: PreviewPending;
};

type PreviewRenderOptions = Pick<RenderBatch, "maxEdge" | "includeBase">;

type WorkerRequest = WorkerCommand extends infer Command
  ? Command extends { requestId: number }
    ? Omit<Command, "requestId">
    : never
  : never;

export class ProcessingClient {
  private readonly worker = new Worker(
    new URL("../workers/processing.worker.ts", import.meta.url),
    { type: "module" },
  );
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private thumbnailListener?: (preview: CameraPreview) => void;
  private previewFrameListener?: (preview: PreviewResult) => void;
  private lookPreviewListener?: (preview: LookPreviewResult) => void;
  private activeRender?: RenderBatch;
  private queuedRender?: RenderBatch;
  private stoppedError?: Error;
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.ok && data.type === "thumbnail") {
        this.thumbnailListener?.(data.result);
        return;
      }
      if (data.ok && data.type === "preview-frame") {
        performance.mark("lutify:initial-preview-frame", {
          detail: data.result.timings,
        });
        this.previewFrameListener?.(data.result);
        return;
      }
      if (data.ok && data.type === "look-preview") {
        this.lookPreviewListener?.(data.result);
        return;
      }
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      if (!data.ok) pending.reject(new Error(data.error));
      else pending.resolve(data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(
        event.message || "The processing worker stopped unexpectedly.",
      );
      this.stoppedError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.rejectQueuedRender(error);
    };
  }

  onThumbnail(listener: (preview: CameraPreview) => void): () => void {
    this.thumbnailListener = listener;
    return () => {
      if (this.thumbnailListener === listener)
        this.thumbnailListener = undefined;
    };
  }

  onPreviewFrame(listener: (preview: PreviewResult) => void): () => void {
    this.previewFrameListener = listener;
    return () => {
      if (this.previewFrameListener === listener)
        this.previewFrameListener = undefined;
    };
  }

  /** Publishes each Look thumbnail as soon as its GPU render completes. */
  onLookPreview(listener: (preview: LookPreviewResult) => void): () => void {
    this.lookPreviewListener = listener;
    return () => {
      if (this.lookPreviewListener === listener)
        this.lookPreviewListener = undefined;
    };
  }

  /** Starts every LUT download concurrently without delaying app startup. */
  async prepareLuts(luts: LutDefinition[]): Promise<void> {
    if (this.stoppedError) throw this.stoppedError;
    const requestId = this.nextRequestId++;
    this.worker.postMessage({ requestId, type: "prepare-luts", luts });
  }

  async clear(): Promise<void> {
    this.rejectQueuedRender(
      new Error("Preview render was superseded by clearing the selection."),
    );
    const reply = await this.send({ type: "clear" });
    if (reply.ok && reply.type === "cleared") return;
    throw new Error("Worker returned an unexpected clear response.");
  }

  /** Marks one decoded photo as recently used without rendering it. */
  async activate(fileId: string): Promise<boolean> {
    const reply = await this.send({ type: "activate", fileId });
    if (reply.ok && reply.type === "activated") return reply.cached;
    throw new Error("Worker returned an unexpected activate response.");
  }

  /** Frees preview resources owned by a removed photo. */
  async release(fileId: string): Promise<void> {
    const reply = await this.send({ type: "release", fileId });
    if (reply.ok && reply.type === "released") return;
    throw new Error("Worker returned an unexpected release response.");
  }

  /** Loads a RAW's embedded thumbnail without decoding its processed Preview. */
  async loadThumbnail(fileId: string, buffer: ArrayBuffer): Promise<boolean> {
    const reply = await this.send({ type: "load-thumbnail", fileId, buffer }, [
      buffer,
    ]);
    if (reply.ok && reply.type === "thumbnail-loaded") return reply.found;
    throw new Error("Worker returned an unexpected thumbnail response.");
  }

  async decode(
    fileId: string,
    buffer: ArrayBuffer,
    ev: number,
    whiteBalance: WhiteBalanceValues,
    lut: LutDefinition,
  ): Promise<DisplayPreviewResult> {
    this.rejectQueuedRender(
      new Error("Preview render was superseded by a new RAW decode."),
    );
    const reply = await this.send(
      {
        type: "decode",
        fileId,
        buffer,
        ev,
        whiteBalance,
        lut,
      },
      [buffer],
    );
    if (reply.ok && reply.type === "preview") {
      performance.mark("lutify:preview-worker", {
        detail: {
          ...reply.result.timings,
          baseEv: reply.result.baseEv,
        },
      });
      return reply.result;
    }
    throw new Error("Worker returned an unexpected decode response.");
  }

  render(
    fileId: string,
    ev: number,
    whiteBalance: WhiteBalanceValues,
    lut: LutDefinition,
    options: PreviewRenderOptions = { maxEdge: 1_024, includeBase: true },
  ): Promise<DisplayPreviewResult> {
    if (this.stoppedError) return Promise.reject(this.stoppedError);

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      if (!this.activeRender) {
        this.startRender({
          fileId,
          ev,
          whiteBalance,
          lut,
          ...options,
          pending,
        });
        return;
      }

      if (this.queuedRender) {
        this.queuedRender.pending.reject(
          new Error("Preview render was superseded by a newer recipe."),
        );
      }
      this.queuedRender = {
        fileId,
        ev,
        whiteBalance,
        lut,
        ...options,
        pending,
      };
    });
  }

  /** Progressively renders one photo through an interruptible LUT batch. */
  async renderLooks(
    fileId: string,
    ev: number,
    whiteBalance: WhiteBalanceValues,
    luts: LutDefinition[],
    maxEdge: number,
  ): Promise<number> {
    const startedAt = performance.now();
    const reply = await this.send({
      type: "render-looks",
      fileId,
      ev,
      whiteBalance,
      luts,
      maxEdge,
    });
    if (reply.ok && reply.type === "look-previews") {
      performance.mark("lutify:look-preview-batch", {
        detail: {
          fileId,
          ev,
          requested: luts.length,
          completed: reply.completed,
          durationMs: performance.now() - startedAt,
        },
      });
      return reply.completed;
    }
    throw new Error("Worker returned an unexpected Look preview response.");
  }

  async export(
    fileId: string,
    buffer: ArrayBuffer,
    ev: number,
    whiteBalance: WhiteBalanceValues,
    baseEv: number | undefined,
    lut: LutDefinition,
    format: OutputFormat,
  ): Promise<ExportResult> {
    this.rejectQueuedRender(
      new Error("Preview render was superseded by full-resolution export."),
    );
    const reply = await this.send(
      {
        type: "export",
        fileId,
        buffer,
        ev,
        whiteBalance,
        baseEv,
        lut,
        format,
      },
      [buffer],
    );
    if (reply.ok && reply.type === "export") {
      return {
        bytes: reply.bytes,
        baseEv: reply.baseEv,
        timings: reply.timings,
      };
    }
    throw new Error("Worker returned an unexpected export response.");
  }

  dispose(): void {
    const error = new Error("Processing worker disposed.");
    this.stoppedError = error;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectQueuedRender(error);
  }

  private startRender(batch: RenderBatch): void {
    this.activeRender = batch;
    void this.send({
      type: "render",
      fileId: batch.fileId,
      ev: batch.ev,
      whiteBalance: batch.whiteBalance,
      lut: batch.lut,
      maxEdge: batch.maxEdge,
      includeBase: batch.includeBase,
    })
      .then((reply) => {
        if (!reply.ok || reply.type !== "preview") {
          throw new Error("Worker returned an unexpected render response.");
        }
        performance.mark("lutify:preview-render", {
          detail: {
            fileId: batch.fileId,
            ev: batch.ev,
            whiteBalance: batch.whiteBalance,
            lutId: batch.lut.id,
            maxEdge: batch.maxEdge,
            includeBase: batch.includeBase,
            ...reply.result.timings,
          },
        });
        batch.pending.resolve(reply.result);
      })
      .catch((error: unknown) => {
        const renderError =
          error instanceof Error ? error : new Error(String(error));
        batch.pending.reject(renderError);
      })
      .finally(() => {
        if (this.activeRender !== batch) return;
        this.activeRender = undefined;
        const next = this.queuedRender;
        this.queuedRender = undefined;
        if (next && !this.stoppedError) this.startRender(next);
      });
  }

  private rejectQueuedRender(error: Error): void {
    const queued = this.queuedRender;
    this.queuedRender = undefined;
    if (!queued) return;
    queued.pending.reject(error);
  }

  private send(
    command: WorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<WorkerReply> {
    if (this.stoppedError) return Promise.reject(this.stoppedError);
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage(
          { ...command, requestId } as WorkerCommand,
          transfer,
        );
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
