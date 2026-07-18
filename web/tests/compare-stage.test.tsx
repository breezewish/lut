import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { CompareStage } from "../src/components/compare-stage";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("paints the transferred base buffer without another complete copy", async () => {
  const pixels = new Uint8Array(new ArrayBuffer(4));
  let imagePixels: Uint8ClampedArray<ArrayBuffer> | undefined;
  const putImageData = vi.fn();
  vi.spyOn(
    HTMLCanvasElement.prototype as unknown as {
      getContext(contextId: "2d"): CanvasRenderingContext2D | null;
    },
    "getContext",
  ).mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(data: Uint8ClampedArray<ArrayBuffer>) {
        imagePixels = data;
      }
    },
  );

  render(
    <CompareStage
      base={{ pixels, width: 1, height: 1 }}
      lookLabel="Classic Negative"
      mode="wipe"
    />,
  );

  await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
  expect(screen.getByRole("img", { name: "Base preview" })).toBeVisible();
  expect(imagePixels?.buffer).toBe(pixels.buffer);
});

test("labels and sizes the look layer in split mode", async () => {
  vi.spyOn(
    HTMLCanvasElement.prototype as unknown as {
      getContext(contextId: "2d"): CanvasRenderingContext2D | null;
    },
    "getContext",
  ).mockReturnValue({
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("ImageData", class {});

  render(
    <CompareStage
      look={{ pixels: new Uint8Array(4), width: 1_024, height: 683 }}
      lookLabel="PROVIA"
      mode="split"
    />,
  );

  const canvas = await screen.findByRole("img", { name: "PROVIA preview" });
  expect(canvas).toHaveAttribute("width", "1024");
  expect(canvas).toHaveAttribute("height", "683");
});
