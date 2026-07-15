import "@testing-library/jest-dom/vitest";

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

Object.defineProperty(globalThis, "Worker", {
  value: MockWorker,
  configurable: true,
});
