import { expect, test } from "vitest";

import {
  blendLibRawHighlights,
  classifyLibRawDefectCandidates,
  correctLibRawSerialDefects,
  correctLibRawSparseDefects,
  refineLibRawSerialDirections,
} from "../src/lib/aahd-parity-cpu";

test("matches LibRaw Blend highlight float semantics", () => {
  const records = new Uint32Array([2890442, 14910, 13959, 25973]);

  blendLibRawHighlights(records, [1, 0.38743850588798523, 0.6015890836715698]);

  expect(Array.from(records)).toEqual([2890442, 15079, 14176, 25586]);
});

test("applies LibRaw defect corrections in row order", () => {
  const width = 10;
  const height = 10;
  const mosaic = new Uint16Array(width * height).fill(100);
  mosaic[4 * width + 2] = 0;
  mosaic[4 * width + 4] = 1;

  const result = correctLibRawSerialDefects(
    mosaic,
    width,
    height,
    new Uint32Array([0, 1, 1, 2]),
    [0, 0, 0, 0],
    new Float32Array([1, 1, 1, 1]),
  );

  expect(result.corrected[4 * width + 2]).toBe(100);
  expect(result.corrected[4 * width + 4]).toBe(100);
  expect(result.defects).toEqual(
    new Uint32Array([0, (1 << 10) | (1 << 12), 0, 0]),
  );
  expect(result.extrema).toEqual(new Uint32Array([1, 0, 0, 100, 100, 100]));
  expect(mosaic[4 * width + 2]).toBe(0);
  expect(mosaic[4 * width + 4]).toBe(1);
});

test("sparse defect correction preserves ordered cascades", () => {
  const width = 10;
  const height = 10;
  const scaled = new Uint16Array(width * height).fill(100);
  scaled[4 * width + 2] = 0;
  scaled[4 * width + 4] = 1;
  const candidates = classifyLibRawDefectCandidates(scaled, width, height);

  const defects = correctLibRawSparseDefects(
    scaled,
    width,
    height,
    new Uint32Array([0, 1, 1, 2]),
    candidates,
  );

  expect(scaled[4 * width + 2]).toBe(100);
  expect(scaled[4 * width + 4]).toBe(100);
  expect(defects).toEqual(new Uint32Array([0, (1 << 10) | (1 << 12), 0, 0]));
});

test("applies LibRaw isolated-direction refinement in row order", () => {
  const width = 6;
  const height = 5;
  const directions = new Uint16Array(width * height);
  directions[2 * width + 2] = 4;
  directions[2 * width + 3] = 6;
  directions[2 * width + 1] = 2;
  directions[1 * width + 2] = 2;
  directions[3 * width + 2] = 2;
  directions[1 * width + 3] = 2;
  directions[3 * width + 3] = 2;
  directions[2 * width + 4] = 2;

  const packed = new Uint32Array(Math.ceil(directions.length / 8));
  const refined = refineLibRawSerialDirections(
    directions,
    width,
    height,
    packed,
  );

  expect(refined[2 * width + 2]).toBe(2);
  expect(refined[2 * width + 3]).toBe(2);
  expect(packed).toEqual(new Uint32Array([0, 0x22200022, 0x00220002, 0]));
  expect(directions[2 * width + 2]).toBe(2);
  expect(directions[2 * width + 3]).toBe(2);
});
