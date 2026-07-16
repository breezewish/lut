import { describe, expect, it } from "vitest";

import {
  buildXtransMasks,
  cameraToProPhoto,
  canonicalXtransOffset,
} from "../src/lib/onnx-demosaic";

describe("Studio demosaic metadata", () => {
  it("derives Studio's Sony camera-to-ProPhoto matrix", () => {
    const matrix = cameraToProPhoto([
      0.6972, -0.2408, -0.06, -0.433, 1.2101, 0.2515, -0.0388, 0.1277, 0.5847,
      0, 0, 0,
    ]);
    expect([...matrix]).toEqual([
      0.7724250555038452, 0.2713833749294281, -0.04380844533443451,
      0.004370653070509434, 1.374617099761963, -0.37898769974708557,
      -0.009262792766094208, -0.1733638346195221, 1.1826266050338745,
    ]);
  });

  it("rejects unsupported four-color matrices", () => {
    expect(() =>
      cameraToProPhoto([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.1, 0, 0]),
    ).toThrow("three-color cameras");
  });

  it("builds Studio's disjoint X-Trans masks", () => {
    const masks = buildXtransMasks();
    expect(masks).toHaveLength(15 * 6 * 6);
    for (let pixel = 0; pixel < 36; pixel += 1) {
      expect(masks[pixel] + masks[36 + pixel] + masks[72 + pixel]).toBe(1);
      let phaseCount = 0;
      for (let mask = 6; mask < 15; mask += 1) {
        phaseCount += masks[mask * 36 + pixel];
      }
      expect(phaseCount).toBe(1);
    }
  });

  it("aligns the X-T1 visible CFA to Studio's canonical phase", () => {
    expect(
      canonicalXtransOffset([
        0, 2, 1, 2, 0, 1, 1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1,
        1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2,
      ]),
    ).toEqual([1, 0]);
  });
});
