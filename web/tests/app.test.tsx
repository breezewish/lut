import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import App from "../src/App";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("teaches the private local workflow before files are selected", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        version: 1,
        contract: { outputStatus: "unverified" },
        luts: [
          {
            id: "fuji-classic-negative",
            group: "Fujifilm",
            name: "Classic Negative",
            file: "look.cube",
            sha256: "00",
          },
        ],
      }),
      { status: 200 },
    ),
  );

  render(<App />);
  expect(
    screen.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();
  expect(screen.getByText("Files stay on this device")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add RAW files" })).toBeEnabled();
  expect(
    screen.queryByRole("region", { name: "Processing controls" }),
  ).not.toBeInTheDocument();
});

test("switches and persists the workspace theme", () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => {}),
  );

  render(<App />);
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));

  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(localStorage.getItem("raw-alchemy-theme")).toBe("light");
});

test("ignores malformed recent-look preferences", async () => {
  localStorage.setItem("raw-alchemy-recent-luts", JSON.stringify({}));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        version: 1,
        contract: { outputStatus: "unverified" },
        luts: [
          {
            id: "fuji-classic-negative",
            group: "Fujifilm",
            name: "Classic Negative",
            file: "look.cube",
            sha256: "00",
          },
        ],
      }),
      { status: 200 },
    ),
  );

  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();
});

test("deduplicates one input batch and accepts drops after the queue is populated", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => {}),
  );

  const { container } = render(<App />);
  const input = container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  const first = new File(["first"], "first.dng", { lastModified: 1 });
  fireEvent.change(input!, { target: { files: [first, first] } });
  expect(screen.getByText("1 local file")).toBeVisible();

  const second = new File(["second"], "second.dng", { lastModified: 2 });
  fireEvent.drop(screen.getByLabelText("RAW queue"), {
    dataTransfer: { files: [second] },
  });
  expect(screen.getByText("2 local files")).toBeVisible();
});

test("renders only after the exposure recipe changes", async () => {
  type Command = {
    requestId: number;
    type: "clear" | "decode" | "render" | "export";
    fileId?: string;
    ev?: number;
    maxEdge?: number;
    includeBase?: boolean;
  };

  class RecipeWorker {
    static instance: RecipeWorker;
    readonly commands: Command[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
      RecipeWorker.instance = this;
    }

    postMessage(command: Command) {
      this.commands.push(command);
      if (command.type !== "decode" && command.type !== "render") return;
      if (command.type === "decode") return;

      this.replyPreview(command);
    }

    replyToDecode() {
      const command = this.commands.find(({ type }) => type === "decode");
      if (!command) throw new Error("No decode command is waiting");
      this.replyPreview(command);
    }

    private replyPreview(command: Command) {
      const red = command.type === "decode" ? 20 : 100 + command.ev!;
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: true,
              type: "preview",
              result: {
                fileId: command.fileId,
                width: command.maxEdge ?? 1,
                height: command.maxEdge ?? 1,
                base:
                  command.includeBase === false
                    ? undefined
                    : new Uint8Array([red, 0, 0, 255]),
                lut: new Uint8Array([red + 1, 0, 0, 255]),
                metadata: { camera: "Test Camera", width: 1, height: 1 },
                decodeCount: 1,
                timings: {
                  previewBackend: "webgpu",
                  libraw: {},
                  previewSourceMs: 0,
                  lutLoadMs: 0,
                  previewColorMs: 0,
                  workerTotalMs: 0,
                },
              },
            },
          }),
        ),
      );
    }

    terminate() {}
  }

  const paintedRedValues: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData: (image: { data: Uint8ClampedArray }) => {
      paintedRedValues.push(image.data[0]);
    },
  } as unknown as GPUCanvasContext);
  vi.stubGlobal(
    "ImageData",
    class {
      readonly data: Uint8ClampedArray;

      constructor(data: Uint8ClampedArray) {
        this.data = data;
      }
    },
  );
  vi.stubGlobal("Worker", RecipeWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        version: 1,
        contract: { outputStatus: "unverified" },
        luts: [
          {
            id: "fuji-classic-negative",
            group: "Fujifilm",
            name: "Classic Negative",
            file: "look.cube",
            sha256: "00",
          },
        ],
      }),
      { status: 200 },
    ),
  );

  const { container } = render(<App />);
  const raw = new File(["raw"], "photo.dng");
  Object.defineProperty(raw, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [raw] },
  });
  const exportButton = await screen.findByRole("button", {
    name: "Export selected",
  });
  expect(exportButton).toBeDisabled();
  RecipeWorker.instance.replyToDecode();
  await waitFor(() =>
    expect(screen.getByLabelText("Base preview")).toBeVisible(),
  );
  expect(exportButton).toBeEnabled();

  await new Promise((resolve) => window.setTimeout(resolve, 260));
  expect(
    RecipeWorker.instance.commands.filter(({ type }) => type === "render"),
  ).toEqual([]);

  fireEvent.change(screen.getByRole("slider", { name: "Exposure" }), {
    target: { value: "1" },
  });
  expect(exportButton).toBeDisabled();
  await waitFor(() =>
    expect(
      RecipeWorker.instance.commands.filter(({ type }) => type === "render"),
    ).toEqual([
      expect.objectContaining({
        type: "render",
        ev: 1,
        maxEdge: 1024,
        includeBase: true,
      }),
    ]),
  );
  await waitFor(() => expect(paintedRedValues.slice(-2)).toEqual([101, 102]));
  expect(exportButton).toBeEnabled();
});
