import type {
  CameraPreview,
  LutDefinition,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
} from "../types";

type Pending = {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
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
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
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
    const reply = await this.send({ type: "decode", fileId, buffer, ev, lut }, [
      buffer,
    ]);
    if (reply.ok && reply.type === "preview") return reply.result;
    throw new Error("Worker returned an unexpected decode response.");
  }

  async render(
    fileId: string,
    ev: number,
    lut: LutDefinition,
  ): Promise<PreviewResult> {
    const reply = await this.send({ type: "render", fileId, ev, lut });
    if (reply.ok && reply.type === "preview") return reply.result;
    throw new Error("Worker returned an unexpected render response.");
  }

  async export(
    fileId: string,
    buffer: ArrayBuffer,
    ev: number,
    lut: LutDefinition,
  ): Promise<Uint8Array> {
    const reply = await this.send({ type: "export", fileId, buffer, ev, lut }, [
      buffer,
    ]);
    if (reply.ok && reply.type === "export") return reply.tiff;
    throw new Error("Worker returned an unexpected export response.");
  }

  dispose(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Processing worker disposed."));
    }
    this.pending.clear();
  }

  private send(
    command: WorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<WorkerReply> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(
        { ...command, requestId } as WorkerCommand,
        transfer,
      );
    });
  }
}
