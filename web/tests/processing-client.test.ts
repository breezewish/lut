import { afterEach, expect, test, vi } from "vitest";

import { ProcessingClient } from "../src/lib/processing-client";
import type {
  ExportTimings,
  LutDefinition,
  PreviewResult,
  WorkerCommand,
  WorkerReply,
} from "../src/types";

const lut: LutDefinition = {
  id: "look",
  group: "Test",
  name: "Look",
  file: "look.cube",
  sha256: "00",
};

const exportTimings: ExportTimings = {
  libraw: {
    quality: 12,
    inputCopyMs: 1,
    openMs: 2,
    unpackMs: 3,
    preprocessMs: 4,
    demosaicMs: 5,
    postprocessMs: 6,
    colorConversionMs: 7,
    previewResizeMs: 0,
    processRemainderMs: 8,
    rgb16Ms: 9,
    totalMs: 45,
  },
  rawBackend: "libraw",
  colorBackend: "webgpu",
  colorProcessingMs: 10,
  tiffEncodingMs: 11,
  workerTotalMs: 66,
};

function bitmap(value: number): ImageBitmap {
  return { width: 1, height: 1, value } as unknown as ImageBitmap;
}

class ControlledWorker {
  static instance: ControlledWorker;
  readonly messages: WorkerCommand[] = [];
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() {
    ControlledWorker.instance = this;
  }

  postMessage(message: WorkerCommand) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(data: WorkerReply) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

function preview(fileId: string, value: number): PreviewResult {
  return {
    fileId,
    width: 1,
    height: 1,
    base: new Uint8Array([value, value, value, 255]),
    lut: new Uint8Array([value, value, value, 255]),
    metadata: { camera: "Test Camera", width: 1, height: 1 },
    decodeCount: 1,
    timings: {
      previewBackend: "webgpu",
      libraw: exportTimings.libraw,
      previewSourceMs: 10,
      lutLoadMs: 0,
      previewColorMs: 11,
      workerTotalMs: 66,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("activates and releases retained photo previews", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  const activation = client.activate("one");
  const activateCommand = ControlledWorker.instance.messages[0];
  ControlledWorker.instance.reply({
    requestId: activateCommand.requestId,
    ok: true,
    type: "activated",
    cached: true,
  });
  await expect(activation).resolves.toBe(true);

  const release = client.release("one");
  const releaseCommand = ControlledWorker.instance.messages[1];
  ControlledWorker.instance.reply({
    requestId: releaseCommand.requestId,
    ok: true,
    type: "released",
  });
  await expect(release).resolves.toBeUndefined();
  expect(ControlledWorker.instance.messages.map(({ type }) => type)).toEqual([
    "activate",
    "release",
  ]);
  client.dispose();
});

test("starts LUT preparation without waiting for every download", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  await expect(client.prepareLuts([lut])).resolves.toBeUndefined();
  expect(ControlledWorker.instance.messages).toEqual([
    expect.objectContaining({ type: "prepare-luts", luts: [lut] }),
  ]);
  client.dispose();
});

test("publishes each look thumbnail before its Worker batch finishes", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();
  const onLookPreview = vi.fn();
  client.onLookPreview(onLookPreview);

  const rendering = client.renderLooks("one", 1, [lut], 132);
  const command = ControlledWorker.instance.messages[0];
  expect(command).toMatchObject({
    type: "render-looks",
    fileId: "one",
    ev: 1,
    luts: [lut],
    maxEdge: 132,
  });
  const image = bitmap(1);
  ControlledWorker.instance.reply({
    requestId: command.requestId,
    ok: true,
    type: "look-preview",
    result: {
      fileId: "one",
      ev: 1,
      lutId: lut.id,
      width: 1,
      height: 1,
      bitmap: image,
    },
  });
  expect(onLookPreview).toHaveBeenCalledWith({
    fileId: "one",
    ev: 1,
    lutId: lut.id,
    width: 1,
    height: 1,
    bitmap: image,
  });
  ControlledWorker.instance.reply({
    requestId: command.requestId,
    ok: true,
    type: "look-previews",
    fileId: "one",
    completed: 1,
  });

  await expect(rendering).resolves.toBe(1);
  client.dispose();
});

test("supersedes queued exposure renders with the latest request", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  const first = client.render("one", 0.1, lut);
  const superseded = client.render("one", 0.2, lut);
  const supersededOutcome = superseded.catch((error: Error) => error);
  const latest = client.render("one", 0.3, lut);

  expect(
    ControlledWorker.instance.messages.map((message) => [
      message.type,
      "ev" in message ? message.ev : undefined,
    ]),
  ).toEqual([["render", 0.1]]);

  const firstCommand = ControlledWorker.instance.messages[0];
  const firstPreview = preview("one", 10);
  ControlledWorker.instance.reply({
    requestId: firstCommand.requestId,
    ok: true,
    type: "preview",
    result: firstPreview,
  });
  await expect(first).resolves.toBe(firstPreview);

  expect(
    ControlledWorker.instance.messages.map((message) => [
      message.type,
      "ev" in message ? message.ev : undefined,
    ]),
  ).toEqual([
    ["render", 0.1],
    ["render", 0.3],
  ]);

  const latestCommand = ControlledWorker.instance.messages[1];
  const latestPreview = preview("one", 30);
  ControlledWorker.instance.reply({
    requestId: latestCommand.requestId,
    ok: true,
    type: "preview",
    result: latestPreview,
  });

  await expect(supersededOutcome).resolves.toMatchObject({
    message: "Preview render was superseded by a newer recipe.",
  });
  await expect(latest).resolves.toBe(latestPreview);
  client.dispose();
});

test("decode rejects an unsent render instead of dispatching stale exposure", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();
  const onPreviewFrame = vi.fn();
  client.onPreviewFrame(onPreviewFrame);

  const rendering = client.render("one", 0.1, lut);
  const staleRender = client.render("one", 0.2, lut);
  const staleOutcome = staleRender.then(
    () => "resolved",
    () => "rejected",
  );
  const decoding = client.decode("two", new ArrayBuffer(1), 0, lut);

  expect(
    ControlledWorker.instance.messages.map((message) => message.type),
  ).toEqual(["render", "decode"]);
  await expect(staleOutcome).resolves.toBe("rejected");

  const renderCommand = ControlledWorker.instance.messages[0];
  ControlledWorker.instance.reply({
    requestId: renderCommand.requestId,
    ok: true,
    type: "preview",
    result: preview("one", 10),
  });
  const decodeCommand = ControlledWorker.instance.messages[1];
  expect(decodeCommand).toMatchObject({
    type: "decode",
  });
  expect(decodeCommand).not.toHaveProperty("previewBackend");
  expect(decodeCommand).not.toHaveProperty("validatePreviewGpu");
  const initialPreview = preview("two", 15);
  ControlledWorker.instance.reply({
    requestId: decodeCommand.requestId,
    ok: true,
    type: "preview-frame",
    result: initialPreview,
  });
  expect(onPreviewFrame).toHaveBeenCalledWith(initialPreview);
  ControlledWorker.instance.reply({
    requestId: decodeCommand.requestId,
    ok: true,
    type: "preview",
    result: preview("two", 20),
  });

  await expect(rendering).resolves.toMatchObject({ fileId: "one" });
  await expect(decoding).resolves.toMatchObject({ fileId: "two" });
  client.dispose();
});

test("clear rejects an unsent render instead of dispatching stale exposure", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  const rendering = client.render("one", 0.1, lut);
  const staleRender = client.render("one", 0.2, lut);
  const staleOutcome = staleRender.then(
    () => "resolved",
    () => "rejected",
  );
  const clearing = client.clear();

  expect(
    ControlledWorker.instance.messages.map((message) => message.type),
  ).toEqual(["render", "clear"]);
  await expect(staleOutcome).resolves.toBe("rejected");

  const renderCommand = ControlledWorker.instance.messages[0];
  ControlledWorker.instance.reply({
    requestId: renderCommand.requestId,
    ok: true,
    type: "preview",
    result: preview("one", 10),
  });
  const clearCommand = ControlledWorker.instance.messages[1];
  ControlledWorker.instance.reply({
    requestId: clearCommand.requestId,
    ok: true,
    type: "cleared",
  });

  await expect(rendering).resolves.toMatchObject({ fileId: "one" });
  await expect(clearing).resolves.toBeUndefined();
  client.dispose();
});

test("export rejects an unsent render instead of dispatching stale exposure", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  const rendering = client.render("one", 0.1, lut);
  const staleRender = client.render("one", 0.2, lut);
  const staleOutcome = staleRender.then(
    () => "resolved",
    () => "rejected",
  );
  const exporting = client.export("one", new ArrayBuffer(1), 0.3, lut);

  expect(
    ControlledWorker.instance.messages.map((message) => message.type),
  ).toEqual(["render", "export"]);
  await expect(staleOutcome).resolves.toBe("rejected");

  const renderCommand = ControlledWorker.instance.messages[0];
  ControlledWorker.instance.reply({
    requestId: renderCommand.requestId,
    ok: true,
    type: "preview",
    result: preview("one", 10),
  });
  const exportCommand = ControlledWorker.instance.messages[1];
  expect(exportCommand).toMatchObject({ type: "export" });
  expect(exportCommand).not.toHaveProperty("rawBackend");
  expect(exportCommand).not.toHaveProperty("colorBackend");
  expect(exportCommand).not.toHaveProperty("validateGpu");
  const tiff = new Uint8Array([1, 2, 3]);
  ControlledWorker.instance.reply({
    requestId: exportCommand.requestId,
    ok: true,
    type: "export",
    fileId: "one",
    tiff,
    timings: exportTimings,
  });

  await expect(rendering).resolves.toMatchObject({ fileId: "one" });
  await expect(exporting).resolves.toEqual({ tiff, timings: exportTimings });
  client.dispose();
});

test("dispose rejects both active and unsent renders", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ProcessingClient();

  const rendering = client.render("one", 0.1, lut);
  const staleRender = client.render("one", 0.2, lut);
  const renderingOutcome = rendering.catch((error: Error) => error);
  const staleOutcome = staleRender.catch((error: Error) => error);
  client.dispose();

  expect(
    ControlledWorker.instance.messages.map((message) => message.type),
  ).toEqual(["render"]);
  await expect(renderingOutcome).resolves.toMatchObject({
    message: "Processing worker disposed.",
  });
  await expect(staleOutcome).resolves.toMatchObject({
    message: "Processing worker disposed.",
  });
  expect(ControlledWorker.instance.terminated).toBe(true);
});

test("rejects every pending request when the Worker crashes", async () => {
  class CrashingWorker {
    static instance: CrashingWorker;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
      CrashingWorker.instance = this;
    }

    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal("Worker", CrashingWorker);
  const client = new ProcessingClient();
  const first = client.decode("one", new ArrayBuffer(1), 0, lut);
  const second = client.render("one", 1, lut);
  const third = client.render("one", 2, lut);

  CrashingWorker.instance.onerror?.(
    new ErrorEvent("error", { message: "worker crashed" }),
  );

  await expect(first).rejects.toThrow("worker crashed");
  await expect(second).rejects.toThrow("worker crashed");
  await expect(third).rejects.toThrow("worker crashed");
  client.dispose();
});
