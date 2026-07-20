import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import App from "../src/App";

const MANIFEST = {
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
};

function bitmap(value: number): ImageBitmap {
  return { width: 1, height: 1, value } as unknown as ImageBitmap;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("teaches the private local workflow before files are selected", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(MANIFEST), { status: 200 }),
  );

  render(<App />);
  expect(screen.getByRole("heading", { name: "LUTify" })).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();
  expect(
    screen.getAllByText("Files stay on this device").length,
  ).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Add RAW files" })).toBeEnabled();
  // The adjustment rail stays hidden until a photo is selected — no controls
  // hovering over an empty canvas.
  expect(screen.queryByRole("slider", { name: "Exposure" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export photo" })).toBeNull();
});

test("explains how to recover from Nikon High Efficiency RAW", async () => {
  class NikonHighEfficiencyWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(command: { requestId: number; type: string }) {
      if (command.type !== "decode") return;
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: false,
              error: "LUTIFY_UNSUPPORTED_NIKON_HIGH_EFFICIENCY_RAW",
            },
          }),
        ),
      );
    }

    terminate() {}
  }

  vi.stubGlobal("Worker", NikonHighEfficiencyWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(MANIFEST), { status: 200 }),
  );

  const { container } = render(<App />);
  const file = new File(["high efficiency raw"], "DSC_4089.NEF");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Nikon High Efficiency RAW is not supported",
  });
  expect(dialog).toHaveTextContent("This NEF uses TicoRAW");
  expect(dialog).toHaveTextContent("Adobe Lightroom / Photoshop");
  expect(dialog).toHaveTextContent("Adobe DNG Converter");
  expect(dialog).toHaveTextContent("Lossless Compression");
  expect(
    screen.getByRole("link", { name: "Get Adobe DNG Converter" }),
  ).toHaveAttribute(
    "href",
    "https://helpx.adobe.com/camera-raw/digital-negative.html",
  );
  expect(screen.queryByText("The file may be damaged")).toBeNull();
});

test("explains how to recover from GoPro GPR", async () => {
  class UnsupportedGoProWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(command: { requestId: number; type: string }) {
      if (command.type !== "decode") return;
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: false,
              error: "LUTIFY_UNSUPPORTED_GOPRO_GPR",
            },
          }),
        ),
      );
    }

    terminate() {}
  }

  vi.stubGlobal("Worker", UnsupportedGoProWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(MANIFEST), { status: 200 }),
  );

  const { container } = render(<App />);
  const file = new File(["gpr"], "GOPR0055.GPR");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });

  const dialog = await screen.findByRole("dialog", {
    name: "GoPro GPR is not supported",
  });
  expect(dialog).toHaveTextContent("VC-5 compression");
  expect(dialog).toHaveTextContent("Adobe Lightroom / Photoshop");
  expect(screen.queryByText("The file may be damaged")).toBeNull();
});

test("explains how to avoid JPEG XL compression in future ProRAW photos", async () => {
  class UnsupportedJpegXlWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(command: { requestId: number; type: string }) {
      if (command.type !== "decode") return;
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: false,
              error: "LUTIFY_UNSUPPORTED_JPEG_XL_DNG",
            },
          }),
        ),
      );
    }

    terminate() {}
  }

  vi.stubGlobal("Worker", UnsupportedJpegXlWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(MANIFEST), { status: 200 }),
  );

  const { container } = render(<App />);
  const file = new File(["jpeg xl dng"], "IMG_7034.DNG");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });

  const dialog = await screen.findByRole("dialog", {
    name: "JPEG XL–compressed DNG is not supported",
  });
  expect(dialog).toHaveTextContent("stores its RAW image with JPEG XL");
  expect(dialog).toHaveTextContent("JPEG Lossless (Most Compatible)");
  expect(screen.queryByText("The file may be damaged")).toBeNull();
});

test("switches and persists the workspace theme", () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => {}),
  );

  render(<App />);
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));

  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(localStorage.getItem("lutify-theme")).toBe("light");
});

test("deduplicates one input batch and accepts drops after the queue is populated", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => {}),
  );

  const { container } = render(<App />);
  const input = container.querySelector('input[type="file"]');
  const app = container.querySelector(".app");
  expect(input).not.toBeNull();
  expect(app).not.toBeNull();

  const first = new File(["first"], "first.dng", { lastModified: 1 });
  fireEvent.change(input!, { target: { files: [first, first] } });
  expect(screen.getByRole("button", { name: /^first\.dng/ })).toBeVisible();

  const second = new File(["second"], "second.dng", { lastModified: 2 });
  fireEvent.drop(app!, { dataTransfer: { files: [second] } });
  expect(screen.getByRole("button", { name: /^second\.dng/ })).toBeVisible();
});

test("renders the main preview only after the exposure recipe changes", async () => {
  const manifest = {
    ...MANIFEST,
    luts: [
      ...MANIFEST.luts,
      {
        id: "second-look",
        group: "Test",
        name: "Second Look",
        file: "second.cube",
        sha256: "11",
      },
    ],
  };
  type Command = {
    requestId: number;
    type: "clear" | "decode" | "render" | "export";
    fileId?: string;
    ev?: number;
    maxEdge?: number;
    includeBase?: boolean;
    lut?: { id: string };
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
    }

    replyToDecode() {
      const command = this.commands.find(({ type }) => type === "decode");
      if (!command) throw new Error("No decode command is waiting");
      this.replyPreview(command);
    }

    replyToRender(index: number) {
      const command = this.commands.filter(({ type }) => type === "render")[
        index
      ];
      if (!command) throw new Error(`Render ${index} is not waiting`);
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
                baseEv: 1.25,
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
                  autoExposureMs: 0,
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
    drawImage: () => {},
  } as unknown as GPUCanvasContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
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
    new Response(JSON.stringify(manifest), { status: 200 }),
  );

  // Look thumbnails use a separate batch command, so every ordinary render is
  // part of the main progressive comparison.
  const mainRenders = () =>
    RecipeWorker.instance.commands.filter(({ type }) => type === "render");

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
  await waitFor(() =>
    expect(
      RecipeWorker.instance.commands.some(({ type }) => type === "decode"),
    ).toBe(true),
  );
  RecipeWorker.instance.replyToDecode();
  await waitFor(() =>
    expect(screen.getByLabelText("Base preview")).toBeVisible(),
  );
  expect(exportButton).toBeEnabled();

  await new Promise((resolve) => window.setTimeout(resolve, 260));
  expect(mainRenders()).toEqual([]);

  const exposure = screen.getByRole("slider", { name: "Exposure" });
  fireEvent.pointerDown(exposure);
  await new Promise((resolve) => window.setTimeout(resolve, 100));
  expect(mainRenders()).toEqual([]);
  fireEvent.input(exposure, {
    target: { value: "1" },
  });
  expect(exportButton).toBeDisabled();
  await waitFor(() =>
    expect(mainRenders()[0]).toEqual(
      expect.objectContaining({
        type: "render",
        ev: 1,
        maxEdge: 256,
        includeBase: true,
      }),
    ),
  );
  fireEvent.input(exposure, { target: { value: "2" } });
  expect(mainRenders()).toHaveLength(1);
  RecipeWorker.instance.replyToRender(0);
  await waitFor(() =>
    expect(mainRenders()[1]).toEqual(
      expect.objectContaining({
        type: "render",
        ev: 2,
        maxEdge: 256,
        includeBase: true,
      }),
    ),
  );
  RecipeWorker.instance.replyToRender(1);
  fireEvent.pointerUp(exposure);
  expect(exportButton).toBeDisabled();
  await waitFor(() =>
    expect(mainRenders()[2]).toEqual(
      expect.objectContaining({
        type: "render",
        ev: 2,
        maxEdge: 1024,
        includeBase: true,
      }),
    ),
  );
  RecipeWorker.instance.replyToRender(2);
  await waitFor(() => expect(paintedRedValues.slice(-2)).toEqual([102, 103]));
  expect(exportButton).toBeEnabled();

  fireEvent.pointerDown(exposure);
  fireEvent.input(exposure, { target: { value: "1" } });
  await waitFor(() =>
    expect(mainRenders()[3]).toEqual(
      expect.objectContaining({ ev: 1, maxEdge: 256 }),
    ),
  );
  fireEvent.input(exposure, { target: { value: "2" } });
  fireEvent.pointerUp(exposure);
  RecipeWorker.instance.replyToRender(3);
  await waitFor(() =>
    expect(mainRenders()[4]).toEqual(
      expect.objectContaining({ ev: 2, maxEdge: 1024 }),
    ),
  );
  RecipeWorker.instance.replyToRender(4);
  await waitFor(() => expect(exportButton).toBeEnabled());

  fireEvent.pointerDown(exposure);
  fireEvent.input(exposure, { target: { value: "1" } });
  await waitFor(() =>
    expect(mainRenders()[5]).toEqual(
      expect.objectContaining({ ev: 1, maxEdge: 256 }),
    ),
  );
  RecipeWorker.instance.replyToRender(5);
  await waitFor(() =>
    expect(mainRenders()[6]).toEqual(
      expect.objectContaining({ ev: 1, maxEdge: 1024 }),
    ),
  );
  RecipeWorker.instance.replyToRender(6);
  fireEvent.pointerUp(exposure);
  await waitFor(() => expect(exportButton).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: "Second Look" }));
  await waitFor(() =>
    expect(mainRenders()[7]).toEqual(
      expect.objectContaining({
        lut: expect.objectContaining({ id: "second-look" }),
        maxEdge: 256,
        includeBase: false,
      }),
    ),
  );
  RecipeWorker.instance.replyToRender(7);
  await waitFor(() =>
    expect(mainRenders()[8]).toEqual(
      expect.objectContaining({
        lut: expect.objectContaining({ id: "second-look" }),
        maxEdge: 1024,
        includeBase: false,
      }),
    ),
  );
  RecipeWorker.instance.replyToRender(8);
  await waitFor(() => expect(exportButton).toBeEnabled());
});

test("reuses a decoded photo when switching back to it", async () => {
  type Command = {
    requestId: number;
    type: "activate" | "clear" | "decode" | "render" | "export";
    fileId?: string;
    ev?: number;
    maxEdge?: number;
    includeBase?: boolean;
  };

  class CachedPhotoWorker {
    static instance: CachedPhotoWorker;
    readonly commands: Command[] = [];
    readonly decoded = new Set<string>();
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
      CachedPhotoWorker.instance = this;
    }

    postMessage(command: Command) {
      this.commands.push(command);
      if (command.type === "activate") {
        this.reply(command, {
          requestId: command.requestId,
          ok: true,
          type: "activated",
          cached: this.decoded.has(command.fileId!),
        });
        return;
      }
      if (command.type === "decode") this.decoded.add(command.fileId!);
      if (command.type === "decode" || command.type === "render") {
        this.reply(command, {
          requestId: command.requestId,
          ok: true,
          type: "preview",
          result: {
            fileId: command.fileId,
            baseEv: 1.25,
            width: 1,
            height: 1,
            base:
              command.includeBase === false
                ? undefined
                : new Uint8Array([20, 0, 0, 255]),
            lut: new Uint8Array([21, 0, 0, 255]),
            metadata: { camera: "Test Camera", width: 1, height: 1 },
            decodeCount: this.decoded.size,
            timings: {
              previewBackend: "webgpu",
              libraw: {},
              previewSourceMs: 0,
              autoExposureMs: 0,
              lutLoadMs: 0,
              previewColorMs: 0,
              workerTotalMs: 0,
            },
          },
        });
      }
    }

    private reply(command: Command, data: object) {
      queueMicrotask(() =>
        this.onmessage?.(new MessageEvent("message", { data })),
      );
    }

    terminate() {}
  }

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData: () => {},
    drawImage: () => {},
  } as unknown as GPUCanvasContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
  vi.stubGlobal("ImageData", class {});
  vi.stubGlobal("Worker", CachedPhotoWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(MANIFEST), { status: 200 }),
  );

  const { container } = render(<App />);
  const first = new File(["first"], "first.dng", { lastModified: 1 });
  const second = new File(["second"], "second.dng", { lastModified: 2 });
  for (const file of [first, second]) {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(3),
    });
  }
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [first, second] },
  });
  await screen.findByRole("button", { name: /first\.dng — Ready/ });
  expect(screen.getByLabelText("Current document")).toHaveTextContent(
    "first.dngTest Camera1 × 1",
  );
  expect(screen.getByLabelText("Output")).toHaveTextContent("Export photo");
  expect(screen.getByLabelText("Output")).not.toHaveTextContent("Camera");
  expect(screen.queryByText("2 photos")).toBeNull();

  fireEvent.pointerDown(screen.getByRole("button", { name: /^second\.dng/ }));
  await screen.findByRole("button", { name: /second\.dng — Ready/ });
  fireEvent.pointerDown(screen.getByRole("button", { name: /^first\.dng/ }));
  await screen.findByRole("button", { name: /first\.dng — Ready/ });

  expect(
    CachedPhotoWorker.instance.commands.filter(({ type }) => type === "decode"),
  ).toHaveLength(2);
  expect(
    CachedPhotoWorker.instance.commands.filter(
      ({ type }) => type === "activate",
    ),
  ).toHaveLength(1);
  expect(screen.queryByText("Decoding preview…")).toBeNull();
});

test("rerenders every look thumbnail after exposure changes", async () => {
  const manifest = {
    ...MANIFEST,
    luts: [
      {
        id: "second-look",
        group: "Test",
        name: "Second Look",
        file: "second.cube",
        sha256: "11",
      },
      ...MANIFEST.luts,
    ],
  };
  type Command = {
    requestId: number;
    type:
      | "activate"
      | "clear"
      | "decode"
      | "prepare-luts"
      | "render"
      | "render-looks"
      | "export";
    fileId?: string;
    ev?: number;
    maxEdge?: number;
    includeBase?: boolean;
    lut?: { id: string };
    luts?: { id: string }[];
  };

  class ThumbnailWorker {
    static instance: ThumbnailWorker;
    readonly commands: Command[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
      ThumbnailWorker.instance = this;
    }

    postMessage(command: Command) {
      this.commands.push(command);
      if (command.type === "render-looks") {
        if (command.ev !== 0) return;
        queueMicrotask(() => this.replyLookBatch(command, command.luts!));
        return;
      }
      if (command.type !== "decode" && command.type !== "render") return;
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: true,
              type: "preview",
              result: {
                fileId: command.fileId,
                baseEv: 1.25,
                width: 1,
                height: 1,
                base:
                  command.includeBase === false
                    ? undefined
                    : new Uint8Array([20, 0, 0, 255]),
                lut: new Uint8Array([21, 0, 0, 255]),
                metadata: { camera: "Test Camera", width: 1, height: 1 },
                decodeCount: 1,
                timings: {
                  previewBackend: "webgpu",
                  libraw: {},
                  previewSourceMs: 0,
                  autoExposureMs: 0,
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

    replyLookBatch(command: Command, luts: { id: string }[]) {
      for (const lut of luts) {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              requestId: command.requestId,
              ok: true,
              type: "look-preview",
              result: {
                fileId: command.fileId,
                ev: command.ev,
                lutId: lut.id,
                width: 1,
                height: 1,
                bitmap: bitmap(21),
              },
            },
          }),
        );
      }
      this.onmessage?.(
        new MessageEvent("message", {
          data: {
            requestId: command.requestId,
            ok: true,
            type: "look-previews",
            fileId: command.fileId,
            completed: luts.length,
          },
        }),
      );
    }

    terminate() {}
  }

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData: () => {},
    drawImage: () => {},
  } as unknown as GPUCanvasContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
  vi.stubGlobal("ImageData", class {});
  vi.stubGlobal("Worker", ThumbnailWorker);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(manifest), { status: 200 }),
  );

  const { container } = render(<App />);
  const raw = new File(["raw"], "photo.dng");
  Object.defineProperty(raw, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [raw] },
  });

  const thumbnailBatches = (ev: number) =>
    ThumbnailWorker.instance.commands.filter(
      (command) =>
        command.type === "render-looks" &&
        command.maxEdge === 132 &&
        command.ev === ev,
    );
  await waitFor(() => expect(thumbnailBatches(0)).toHaveLength(1));
  expect(thumbnailBatches(0)[0].luts?.map(({ id }) => id)).toEqual([
    "fuji-classic-negative",
    "second-look",
  ]);
  await waitFor(() =>
    expect(container.querySelectorAll(".look__thumb canvas")).toHaveLength(2),
  );

  fireEvent.input(screen.getByRole("slider", { name: "Exposure" }), {
    target: { value: "1" },
  });
  await waitFor(() => expect(thumbnailBatches(1)).toHaveLength(1));
  expect(container.querySelectorAll(".look__thumb canvas")).toHaveLength(2);
  ThumbnailWorker.instance.replyLookBatch(thumbnailBatches(1)[0], [
    { id: "fuji-classic-negative" },
  ]);
  await waitFor(() => expect(thumbnailBatches(1)).toHaveLength(2));
  expect(thumbnailBatches(1)[1].luts?.map(({ id }) => id)).toEqual([
    "second-look",
  ]);
});
