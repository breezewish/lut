import { render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { LookPanel } from "../src/components/look-panel";

test("composites worker-created thumbnails without synchronous pixel painting", async () => {
  const bitmap = { width: 1, height: 1 } as ImageBitmap;
  const drawImage = vi.fn();
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    putImageData,
  } as unknown as GPUCanvasContext);

  render(
    <LookPanel
      looks={[
        {
          id: "look",
          group: "Test",
          name: "Look",
          file: "look.ralut",
          sha256: "00",
        },
      ]}
      activeId="look"
      onChoose={() => {}}
      thumbs={new Map([["look", { bitmap, width: 1, height: 1 }]])}
      query=""
      onQuery={() => {}}
    />,
  );

  await waitFor(() => expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0));
  expect(putImageData).not.toHaveBeenCalled();
});
