/// <reference lib="webworker" />

import createLibRaw from "../libraw/libraw.js";
import { encodeEmbeddedThumbnail } from "../lib/embedded-thumbnail";
import { describeLibRawError } from "../lib/libraw-error";
import type {
  ThumbnailCommand,
  ThumbnailReply,
} from "../lib/thumbnail-protocol";

const context: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;
const runtime = createLibRaw();
type LibRawModule = Awaited<ReturnType<typeof createLibRaw>>;

let tail = Promise.resolve();

context.onmessage = ({ data }: MessageEvent<ThumbnailCommand>) => {
  tail = tail.then(
    () => loadThumbnail(data),
    () => loadThumbnail(data),
  );
};

async function loadThumbnail(data: ThumbnailCommand): Promise<void> {
  let module: LibRawModule | undefined;
  try {
    module = await runtime;
    const raw = new module.LibRaw();
    try {
      const buffer = await data.file.arrayBuffer();
      raw.openPreview(new Uint8Array(buffer), 1_024);
      const metadata = raw.metadata();
      const thumbnail = raw.thumbnailData();
      const jpeg = thumbnail && (await encodeEmbeddedThumbnail(thumbnail));
      const reply: ThumbnailReply = {
        requestId: data.requestId,
        ok: true,
        result: jpeg
          ? {
              fileId: data.fileId,
              jpeg,
              width: metadata.width,
              height: metadata.height,
            }
          : undefined,
      };
      context.postMessage(reply, jpeg ? [jpeg.buffer] : []);
    } finally {
      raw.delete();
    }
  } catch (error) {
    const reply: ThumbnailReply = {
      requestId: data.requestId,
      ok: false,
      error: module
        ? describeLibRawError(error, module)
        : "The local thumbnail engine could not start.",
    };
    context.postMessage(reply);
  }
}
