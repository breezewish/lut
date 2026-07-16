import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PreviewCanvas } from "../src/components/preview-canvas";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("renders the transferred RGBA buffer without another complete copy", async () => {
  const pixels = new Uint8Array(new ArrayBuffer(4));
  let imagePixels: Uint8ClampedArray<ArrayBuffer> | undefined;
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData,
  } as unknown as GPUCanvasContext);
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(data: Uint8ClampedArray<ArrayBuffer>) {
        imagePixels = data;
      }
    },
  );

  render(
    <PreviewCanvas
      label="Base"
      detail="Neutral"
      pixels={pixels}
      width={1}
      height={1}
    />,
  );

  await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
  expect(screen.getByRole("img", { name: "Base preview" })).toBeVisible();
  expect(imagePixels?.buffer).toBe(pixels.buffer);
});
