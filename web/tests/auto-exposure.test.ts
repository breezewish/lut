import { expect, test } from "vitest";

import {
  AUTO_EXPOSURE_HISTOGRAM_BINS,
  AUTO_EXPOSURE_ZONE_COUNT,
  resolveMatrixAutoExposure,
} from "../src/lib/auto-exposure";

function uniformStats(luminance: number, peak: number) {
  const pixelsPerZone = 100;
  const zoneCounts = new Uint32Array(AUTO_EXPOSURE_ZONE_COUNT).fill(
    pixelsPerZone,
  );
  const zoneLuminanceSums = new Uint32Array(AUTO_EXPOSURE_ZONE_COUNT).fill(
    Math.round(luminance * 65_535 * pixelsPerZone),
  );
  const histogram = new Uint32Array(AUTO_EXPOSURE_HISTOGRAM_BINS);
  histogram[
    Math.min(
      AUTO_EXPOSURE_HISTOGRAM_BINS - 1,
      Math.floor(peak * AUTO_EXPOSURE_HISTOGRAM_BINS),
    )
  ] = AUTO_EXPOSURE_ZONE_COUNT * pixelsPerZone;
  return { zoneLuminanceSums, zoneCounts, histogram };
}

test("maps the Studio matrix-weighted scene luminance to 18% gray", () => {
  const result = resolveMatrixAutoExposure(uniformStats(0.02, 0.1));

  expect(result.gain).toBeCloseTo(9, 3);
  expect(result.ev).toBeCloseTo(Math.log2(9), 3);
});

test("limits matrix auto exposure when the 99th percentile would exceed linear 6", () => {
  const result = resolveMatrixAutoExposure(uniformStats(0.01, 0.5));

  expect(result.gain).toBeCloseTo(12, 1);
  expect(result.ev).toBeCloseTo(Math.log2(12), 1);
});

test("keeps a black frame at neutral gain", () => {
  const result = resolveMatrixAutoExposure(uniformStats(0, 0));

  expect(result).toEqual({ gain: 1, ev: 0 });
});
