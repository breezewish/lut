import { afterEach, expect, test, vi } from "vitest";

import { encodeEmbeddedThumbnail } from "../src/lib/embedded-thumbnail";

afterEach(() => vi.unstubAllGlobals());

test("returns an embedded JPEG without copying or re-encoding it", async () => {
  const data = new Uint8Array([0xff, 0xd8, 0xff]);

  await expect(
    encodeEmbeddedThumbnail({ width: 1, height: 1, format: "jpeg", data }),
  ).resolves.toBe(data);
});

test("rejects an invalid embedded RGB bitmap", async () => {
  await expect(
    encodeEmbeddedThumbnail({
      width: 2,
      height: 1,
      format: "bitmap",
      data: new Uint8Array([1, 2, 3]),
    }),
  ).rejects.toThrow("invalid RGB data");
});

test("encodes an embedded RGB bitmap as JPEG", async () => {
  const putImageData = vi.fn();
  const convertToBlob = vi.fn(async () => ({
    arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
  }));
  class TestCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return { putImageData };
    }
    convertToBlob = convertToBlob;
  }
  class TestImageData {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  vi.stubGlobal("OffscreenCanvas", TestCanvas);
  vi.stubGlobal("ImageData", TestImageData);

  const result = await encodeEmbeddedThumbnail({
    width: 1,
    height: 1,
    format: "bitmap",
    data: new Uint8Array([10, 20, 30]),
  });

  expect(putImageData).toHaveBeenCalledOnce();
  const image = putImageData.mock.calls[0][0] as ImageData;
  expect(Array.from(image.data)).toEqual([10, 20, 30, 255]);
  expect(convertToBlob).toHaveBeenCalledWith({
    type: "image/jpeg",
    quality: 0.8,
  });
  expect(result).toEqual(new Uint8Array([7, 8]));
});
