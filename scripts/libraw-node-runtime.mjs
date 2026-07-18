import {
  isMainThread,
  parentPort,
  Worker as NodeWorker,
  workerData,
} from "node:worker_threads";

const pthreadWorker = !isMainThread && workerData?.librawPthread === true;
const workers = new Set();

if (pthreadWorker) {
  const queued = [];
  let messageHandler;
  globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
  globalThis.name = "em-pthread";
  globalThis.self = globalThis;
  globalThis.postMessage = (message, transfer) =>
    parentPort.postMessage(message, transfer);
  Object.defineProperty(globalThis, "onmessage", {
    get: () => messageHandler,
    set: (handler) => {
      messageHandler = handler;
      while (queued.length > 0) handler({ data: queued.shift() });
    },
  });
  parentPort.on("message", (data) => {
    if (messageHandler) messageHandler({ data });
    else queued.push(data);
  });
  await import("../web/src/libraw/threaded/libraw.js");
}

class WebWorker {
  constructor() {
    this.worker = new NodeWorker(new URL(import.meta.url), {
      workerData: { librawPthread: true },
    });
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) => this.onerror?.(error));
    workers.add(this.worker);
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer);
  }

  terminate() {
    workers.delete(this.worker);
    void this.worker.terminate();
  }
}

/** Loads the production pthread LibRaw module in Node-based validation tools. */
export default async function createLibRaw(options = {}) {
  if (!isMainThread) {
    throw new Error("LibRaw validation must start on the Node main thread");
  }
  globalThis.Worker = WebWorker;
  const { default: create } = await import(
    "../web/src/libraw/threaded/libraw.js"
  );
  const module = await create({
    ...options,
    mainScriptUrlOrBlob: import.meta.url,
  });
  for (const worker of workers) worker.unref();
  return module;
}
