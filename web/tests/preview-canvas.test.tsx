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
  } as unknown as CanvasRenderingContext2D);
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

test("positions preview pixels around a shared normalized inspection focus", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("ImageData", class {});

  render(
    <PreviewCanvas
      label="Look"
      detail="Selected look"
      pixels={new Uint8Array(4)}
      width={1_024}
      height={683}
      viewMode="actual"
      focus={{ x: 0.25, y: 0.75 }}
    />,
  );

  const canvas = await screen.findByRole("img", { name: "Look preview" });
  expect(canvas).toHaveStyle({
    width: "1024px",
    height: "683px",
    left: "calc(50% + 256px)",
    top: "calc(50% + -170.75px)",
  });
});
