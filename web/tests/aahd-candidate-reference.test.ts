import { expect, test } from "vitest";

import {
  correctImmutableDefects,
  refineImmutableIsolatedDirections,
} from "../src/lib/aahd-candidate-reference";

test("classifies every defect from the original mosaic", () => {
  const width = 10;
  const height = 10;
  const mosaic = new Uint16Array(width * height).fill(100);
  mosaic[4 * width + 2] = 0;
  mosaic[4 * width + 4] = 1;

  const result = correctImmutableDefects(mosaic, width, height);

  expect(result.corrected[4 * width + 2]).toBe(100);
  expect(result.corrected[4 * width + 4]).toBe(1);
  expect(result.defects).toEqual(new Uint32Array([0, 1 << 10, 0, 0]));
  expect(mosaic[4 * width + 2]).toBe(0);
  expect(mosaic[4 * width + 4]).toBe(1);
});

test("refines isolated directions from one immutable plane", () => {
  const width = 6;
  const height = 5;
  const directions = new Uint32Array(width * height);
  directions[2 * width + 2] = 4;
  directions[2 * width + 3] = 6;
  directions[2 * width + 1] = 2;
  directions[1 * width + 2] = 2;
  directions[3 * width + 2] = 2;
  directions[1 * width + 3] = 2;
  directions[3 * width + 3] = 2;
  directions[2 * width + 4] = 2;

  const refined = refineImmutableIsolatedDirections(directions, width, height);

  expect(refined[2 * width + 2]).toBe(2);
  expect(refined[2 * width + 3]).toBe(6);
  expect(directions[2 * width + 2]).toBe(4);
  expect(directions[2 * width + 3]).toBe(6);
});
