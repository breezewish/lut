import type {
  CameraPreview,
  DemosaicBenchmarkReport,
  ExportResult,
  LutDefinition,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
} from "../types";

type Pending = {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
};

type PreviewPending = {
  resolve: (result: PreviewResult) => void;
  reject: (error: Error) => void;
};

type RenderBatch = {
  fileId: string;
  ev: number;
  lut: LutDefinition;
  pending: PreviewPending;
};

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
  private activeRender?: RenderBatch;
  private queuedRender?: RenderBatch;
  private stoppedError?: Error;
  private readonly colorBackend = (() => {
    const backend = new URLSearchParams(location.search).get("colorBackend");
    return backend === "webgpu" || backend === "onnx" ? backend : "cpu";
  })();
  private readonly validateGpu =
    new URLSearchParams(location.search).get("validateGpu") === "1";

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.ok && data.type === "thumbnail") {
        this.thumbnailListener?.(data.result);
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

  async clear(): Promise<void> {
    this.rejectQueuedRender(
      new Error("Preview render was superseded by clearing the selection."),
    );
    const reply = await this.send({ type: "clear" });
    if (reply.ok && reply.type === "cleared") return;
    throw new Error("Worker returned an unexpected clear response.");
  }

  async decode(
    fileId: string,
    buffer: ArrayBuffer,
    ev: number,
    lut: LutDefinition,
  ): Promise<PreviewResult> {
    this.rejectQueuedRender(
      new Error("Preview render was superseded by a new RAW decode."),
    );
    const reply = await this.send({ type: "decode", fileId, buffer, ev, lut }, [
      buffer,
    ]);
    if (reply.ok && reply.type === "preview") {
      performance.mark("raw-alchemy:preview-worker", {
        detail: reply.result.timings,
      });
      return reply.result;
    }
    throw new Error("Worker returned an unexpected decode response.");
  }

  render(
    fileId: string,
    ev: number,
    lut: LutDefinition,
  ): Promise<PreviewResult> {
    if (this.stoppedError) return Promise.reject(this.stoppedError);

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      if (!this.activeRender) {
        this.startRender({ fileId, ev, lut, pending });
        return;
      }

      if (this.queuedRender) {
        this.queuedRender.pending.reject(
          new Error("Preview render was superseded by a newer recipe."),
        );
      }
      this.queuedRender = { fileId, ev, lut, pending };
    });
  }

  async export(
    fileId: string,
    buffer: ArrayBuffer,
    ev: number,
    lut: LutDefinition,
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
        lut,
        colorBackend: this.colorBackend,
        validateGpu: this.validateGpu,
      },
      [buffer],
    );
    if (reply.ok && reply.type === "export") {
      return { tiff: reply.tiff, timings: reply.timings };
    }
    throw new Error("Worker returned an unexpected export response.");
  }

  async benchmarkDemosaic(
    buffer: ArrayBuffer,
    referenceRgb16?: ArrayBuffer,
  ): Promise<DemosaicBenchmarkReport> {
    const demosaicBackend =
      new URLSearchParams(location.search).get("demosaicBackend") ===
      "native-wgsl"
        ? "native-wgsl"
        : "onnx";
    const demosaicOutputStage =
      new URLSearchParams(location.search).get("demosaicOutputStage") ===
      "demosaic"
        ? "demosaic"
        : "identity-lut";
    const completeExport =
      new URLSearchParams(location.search).get("completeExport") === "1";
    const transfer = referenceRgb16 ? [buffer, referenceRgb16] : [buffer];
    const reply = await this.send(
      {
        type: "benchmark-demosaic",
        buffer,
        referenceRgb16,
        demosaicBackend,
        demosaicOutputStage,
        completeExport,
      },
      transfer,
    );
    if (reply.ok && reply.type === "demosaic-benchmark") return reply.result;
    throw new Error(
      "Worker returned an unexpected demosaic benchmark response.",
    );
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
      lut: batch.lut,
    })
      .then((reply) => {
        if (!reply.ok || reply.type !== "preview") {
          throw new Error("Worker returned an unexpected render response.");
        }
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
