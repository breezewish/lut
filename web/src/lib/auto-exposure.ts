export const AUTO_EXPOSURE_GRID_SIZE = 7;
export const AUTO_EXPOSURE_ZONE_COUNT =
  AUTO_EXPOSURE_GRID_SIZE * AUTO_EXPOSURE_GRID_SIZE;
export const AUTO_EXPOSURE_HISTOGRAM_BINS = 1_024;

const LINEAR_CODE_MAXIMUM = 65_535;
const TARGET_GRAY = 0.18;
const MAXIMUM_HIGHLIGHT = 6;

export interface AutoExposureStatistics {
  zoneLuminanceSums: ArrayLike<number>;
  zoneCounts: ArrayLike<number>;
  histogram: ArrayLike<number>;
}

export interface AutoExposure {
  gain: number;
  ev: number;
}

/** Resolves Studio's matrix-metering policy from bounded GPU statistics. */
export function resolveMatrixAutoExposure(
  statistics: AutoExposureStatistics,
): AutoExposure {
  const { zoneLuminanceSums, zoneCounts, histogram } = statistics;
  if (
    zoneLuminanceSums.length !== AUTO_EXPOSURE_ZONE_COUNT ||
    zoneCounts.length !== AUTO_EXPOSURE_ZONE_COUNT ||
    histogram.length !== AUTO_EXPOSURE_HISTOGRAM_BINS
  ) {
    throw new Error("Automatic exposure statistics have an invalid shape.");
  }

  const zones: Array<{ index: number; luminance: number }> = [];
  for (let index = 0; index < AUTO_EXPOSURE_ZONE_COUNT; index += 1) {
    const count = zoneCounts[index];
    if (count === 0) continue;
    zones.push({
      index,
      luminance: zoneLuminanceSums[index] / (count * LINEAR_CODE_MAXIMUM),
    });
  }
  if (zones.length === 0) return { gain: 1, ev: 0 };

  const sorted = zones
    .map(({ luminance }) => luminance)
    .sort((left, right) => left - right);
  const lowThreshold = percentile(sorted, 0.1);
  const highThreshold = percentile(sorted, 0.9);
  const center = (AUTO_EXPOSURE_GRID_SIZE - 1) / 2;
  const sigma = AUTO_EXPOSURE_GRID_SIZE / 2.5;
  let weightedLuminance = 0;
  let totalWeight = 0;
  for (const zone of zones) {
    const x = zone.index % AUTO_EXPOSURE_GRID_SIZE;
    const y = Math.floor(zone.index / AUTO_EXPOSURE_GRID_SIZE);
    const distanceSquared = (x - center) ** 2 + (y - center) ** 2;
    let weight = 1 + Math.exp(-distanceSquared / (2 * sigma ** 2)) * 1.5;
    if (zone.luminance > highThreshold) weight *= 0.2;
    if (zone.luminance < lowThreshold) weight *= 1.2;
    weightedLuminance += zone.luminance * weight;
    totalWeight += weight;
  }
  weightedLuminance /= totalWeight;
  if (weightedLuminance < 1e-6) return { gain: 1, ev: 0 };

  let gain = TARGET_GRAY / weightedLuminance;
  const highlight = histogramPercentile(histogram, 0.99);
  if (highlight > 1e-6 && highlight * gain > MAXIMUM_HIGHLIGHT) {
    gain = MAXIMUM_HIGHLIGHT / highlight;
  }
  gain = Math.min(100, Math.max(0.1, gain));
  return { gain, ev: Math.log2(gain) };
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function histogramPercentile(
  histogram: ArrayLike<number>,
  fraction: number,
): number {
  let pixelCount = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    pixelCount += histogram[index];
  }
  if (pixelCount === 0) return 0;
  const target = Math.floor((pixelCount - 1) * fraction);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative > target) return (index + 1) / histogram.length;
  }
  return 1;
}
