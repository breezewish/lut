import { afterEach, expect, test, vi } from "vitest";

import {
  ThumbnailCancelledError,
  ThumbnailClient,
} from "../src/lib/thumbnail-client";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  readonly messages: object[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(readonly url: URL) {
    ControlledWorker.instances.push(this);
  }

  postMessage(message: object) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  ControlledWorker.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("starts the isolated thumbnail worker lazily and returns its JPEG", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ThumbnailClient();
  const file = new File(["raw"], "photo.dng");

  expect(ControlledWorker.instances).toHaveLength(0);
  const loading = client.load("photo", file);
  const worker = ControlledWorker.instances[0];
  expect(String(worker.url)).toContain("thumbnail.worker.ts");
  expect(worker.messages).toEqual([
    expect.objectContaining({ fileId: "photo", file }),
  ]);

  const request = worker.messages[0] as { requestId: number };
  const jpeg = new Uint8Array([1, 2, 3]);
  worker.onmessage?.(
    new MessageEvent("message", {
      data: {
        requestId: request.requestId,
        ok: true,
        result: { fileId: "photo", jpeg, width: 3, height: 4 },
      },
    }),
  );

  await expect(loading).resolves.toEqual({
    fileId: "photo",
    jpeg,
    width: 3,
    height: 4,
  });
  client.dispose();
  expect(worker.terminated).toBe(true);
});

test("releases idle WASM workers and restarts them on demand", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ThumbnailClient();

  const loading = client.load("first", new File(["raw"], "first.dng"));
  const firstWorker = ControlledWorker.instances[0];
  const request = firstWorker.messages[0] as { requestId: number };
  firstWorker.onmessage?.(
    new MessageEvent("message", {
      data: { requestId: request.requestId, ok: true },
    }),
  );
  await expect(loading).resolves.toBeUndefined();
  expect(firstWorker.terminated).toBe(false);

  vi.advanceTimersByTime(1_000);
  expect(firstWorker.terminated).toBe(true);
  const secondLoading = client.load("second", new File(["raw"], "second.dng"));
  expect(ControlledWorker.instances).toHaveLength(2);
  client.dispose();
  await expect(secondLoading).rejects.toThrow("disposed");
});

test("cancels active background work without poisoning later requests", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ThumbnailClient();
  const loading = client.load("first", new File(["raw"], "first.dng"));
  const firstWorker = ControlledWorker.instances[0];

  client.cancel();
  await expect(loading).rejects.toBeInstanceOf(ThumbnailCancelledError);
  expect(firstWorker.terminated).toBe(true);

  const secondLoading = client.load("second", new File(["raw"], "second.dng"));
  expect(ControlledWorker.instances).toHaveLength(2);
  client.dispose();
  await expect(secondLoading).rejects.toThrow("disposed");
});

test("terminates a failed worker before rejecting its request", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new ThumbnailClient();
  const loading = client.load("photo", new File(["raw"], "photo.dng"));
  const worker = ControlledWorker.instances[0];

  worker.onerror?.(new ErrorEvent("error", { message: "WASM failed" }));

  await expect(loading).rejects.toThrow("WASM failed");
  expect(worker.terminated).toBe(true);
  client.dispose();
});
