import { expect, test, vi } from "vitest";

import { ProcessingClient } from "../src/lib/processing-client";

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
  const lut = {
    id: "look",
    group: "Test",
    name: "Look",
    file: "look.cube",
    sha256: "00",
  };
  const first = client.decode("one", new ArrayBuffer(1), 0, lut);
  const second = client.render("one", 1, lut);

  CrashingWorker.instance.onerror?.(
    new ErrorEvent("error", { message: "worker crashed" }),
  );

  await expect(first).rejects.toThrow("worker crashed");
  await expect(second).rejects.toThrow("worker crashed");
  client.dispose();
  vi.unstubAllGlobals();
});
