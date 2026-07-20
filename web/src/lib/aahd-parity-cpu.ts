const HOR = 2;
const VER = 4;

export function createLibRawGammaLut(): Float32Array<ArrayBuffer> {
  const lut = new Float32Array(65536);
  const exponent = Math.fround(0.45);
  const gain = Math.fround(1.0993);
  const offset = Math.fround(0.0993);
  for (let index = 0; index < lut.length; index += 1) {
    const sample = Math.fround(index / 65536);
    lut[index] =
      sample < Math.fround(0.0181)
        ? Math.fround(65536 * Math.fround(Math.fround(4.5) * sample))
        : Math.fround(65536 * (gain * Math.pow(sample, exponent) - offset));
  }
  return lut;
}

/** Applies LibRaw's three-channel Blend highlight transform to compact RGB records. */
export function blendLibRawHighlights(
  records: Uint32Array,
  preMultipliers: ArrayLike<number>,
): void {
  if (records.length % 4 !== 0 || preMultipliers.length < 3) {
    throw new Error(
      "LibRaw highlight blending requires index-plus-RGB records and three multipliers.",
    );
  }
  const f32 = Math.fround;
  const clip = Math.min(
    Math.trunc(f32(65535 * preMultipliers[0])),
    Math.trunc(f32(65535 * preMultipliers[1])),
    Math.trunc(f32(65535 * preMultipliers[2])),
  );
  const forward = [
    [1, 1, 1],
    [f32(1.7320508), f32(-1.7320508), 0],
    [-1, -1, 2],
  ];
  const inverse = [
    [1, f32(0.8660254), f32(-0.5)],
    [1, f32(-0.8660254), f32(-0.5)],
    [1, 0, 1],
  ];
  const transform = (rgb: number[]) =>
    forward.map((row) => {
      let sum = f32(0);
      for (let channel = 0; channel < 3; channel += 1) {
        const product = Math.trunc(f32(row[channel] * f32(rgb[channel])));
        sum = f32(sum + f32(product));
      }
      return sum;
    });

  for (let offset = 0; offset < records.length; offset += 4) {
    const source = [
      records[offset + 1],
      records[offset + 2],
      records[offset + 3],
    ];
    const sourceLab = transform(source);
    const clippedLab = transform(
      source.map((sample) => Math.min(sample, clip)),
    );
    const sourceChroma = f32(
      f32(sourceLab[1] * sourceLab[1]) + f32(sourceLab[2] * sourceLab[2]),
    );
    const clippedChroma = f32(
      f32(clippedLab[1] * clippedLab[1]) + f32(clippedLab[2] * clippedLab[2]),
    );
    const ratio = f32(Math.sqrt(f32(clippedChroma / sourceChroma)));
    sourceLab[1] = f32(sourceLab[1] * ratio);
    sourceLab[2] = f32(sourceLab[2] * ratio);
    for (let channel = 0; channel < 3; channel += 1) {
      let restored = f32(0);
      for (let term = 0; term < 3; term += 1) {
        restored = f32(
          restored + f32(inverse[channel][term] * sourceLab[term]),
        );
      }
      records[offset + channel + 1] = Math.trunc(f32(restored / 3));
    }
  }
}

const DEFECT_DEPENDENCIES = [
  [-2, -2],
  [0, -2],
  [2, -2],
  [0, -1],
  [-2, 0],
  [-1, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [-2, 2],
  [0, 2],
  [2, 2],
] as const;

/**
 * Applies the ordered LibRaw scan to a GPU-produced initial candidate mask.
 * A correction schedules every later classification that can observe it, so
 * cascades remain exact without evaluating unaffected pixels.
 */
export function correctLibRawSparseDefects(
  scaled: Uint16Array<ArrayBuffer>,
  width: number,
  height: number,
  cfaPattern: ArrayLike<number>,
  candidates: Uint32Array<ArrayBuffer>,
): Uint32Array<ArrayBuffer> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    scaled.length !== width * height ||
    cfaPattern.length !== 4 ||
    candidates.length !== Math.ceil(scaled.length / 32)
  ) {
    throw new Error("Sparse LibRaw defect correction requires complete input.");
  }

  const defects = new Uint32Array(candidates.length);
  const correctParity = (y: number, start: number) => {
    const rowStart = y * width;
    const rowEnd = rowStart + width;
    const indexParity = (rowStart + start) & 1;
    let nextIndex = rowStart + start;
    while (nextIndex < rowEnd) {
      const wordIndex = nextIndex >>> 5;
      const wordStart = wordIndex * 32;
      const firstBit = nextIndex - wordStart;
      const bitCount = Math.min(rowEnd - wordStart, 32);
      const lowerMask = firstBit === 0 ? 0xffffffff : 0xffffffff << firstBit;
      const upperMask =
        bitCount === 32 ? 0xffffffff : 0xffffffff >>> (32 - bitCount);
      const parityMask = indexParity === 0 ? 0x55555555 : 0xaaaaaaaa;
      const pending =
        candidates[wordIndex] & lowerMask & upperMask & parityMask;
      if (pending === 0) {
        nextIndex = wordStart + 32 + indexParity;
        if ((nextIndex & 1) !== indexParity) nextIndex += 1;
        continue;
      }
      const bit = 31 - Math.clz32(pending & -pending);
      const index = wordStart + bit;
      const x = index - rowStart;
      nextIndex = index + 2;
      const replacement = libRawDefectReplacement(scaled, width, height, x, y);
      if (replacement === undefined) continue;
      scaled[index] = replacement;
      defects[index >>> 5] |= 1 << (index & 31);
      for (const [dx, dy] of DEFECT_DEPENDENCIES) {
        const affectedX = x + dx;
        const affectedY = y + dy;
        if (
          affectedX < 0 ||
          affectedX >= width ||
          affectedY < 0 ||
          affectedY >= height
        ) {
          continue;
        }
        const affected = affectedY * width + affectedX;
        candidates[affected >>> 5] |= 1 << (affected & 31);
      }
    }
  };

  for (let y = 0; y < height; y += 1) {
    const firstChannel = cfaPattern[(y & 1) * 2];
    const nonGreenStart = (firstChannel === 3 ? 1 : firstChannel) & 1;
    correctParity(y, nonGreenStart);
    correctParity(y, nonGreenStart ^ 1);
  }
  return defects;
}

function libRawDefectReplacement(
  samples: Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number | undefined {
  const sample = (sampleX: number, sampleY: number) =>
    sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height
      ? samples[sampleY * width + sampleX]
      : 0;
  const center = sample(x, y);
  const west2 = sample(x - 2, y);
  const east2 = sample(x + 2, y);
  const north2 = sample(x, y - 2);
  const south2 = sample(x, y + 2);
  const west = sample(x - 1, y);
  const east = sample(x + 1, y);
  const north = sample(x, y - 1);
  const south = sample(x, y + 1);
  const hot =
    center > west2 &&
    center > east2 &&
    center > north2 &&
    center > south2 &&
    center > west &&
    center > east &&
    center > north &&
    center > south;
  const dead =
    center < west2 &&
    center < east2 &&
    center < north2 &&
    center < south2 &&
    center < west &&
    center < east &&
    center < north &&
    center < south;
  if (!hot && !dead) return undefined;

  const average = Math.trunc(
    (sample(x - 2, y - 2) +
      north2 +
      sample(x + 2, y - 2) +
      west2 +
      east2 +
      sample(x - 2, y + 2) +
      south2 +
      sample(x + 2, y + 2)) /
      8,
  );
  if (center >> 4 <= average && center << 4 >= average) return undefined;

  const horizontal =
    Math.abs(west2 - east2) +
    Math.abs(west - east) +
    Math.abs(west - east + east2 - west2);
  const vertical =
    Math.abs(north2 - south2) +
    Math.abs(north - south) +
    Math.abs(north - south + south2 - north2);
  return Math.trunc(
    vertical > horizontal ? (west2 + east2) / 2 : (north2 + south2) / 2,
  );
}

/**
 * Reproduces LibRaw AAHD's final ordered isolated-direction scan in place.
 * When supplied, `packed` receives eight four-bit results per word during the
 * same row traversal.
 */
export function refineLibRawSerialDirections(
  directions: Uint16Array<ArrayBuffer>,
  width: number,
  height: number,
  packed?: Uint32Array,
): Uint16Array<ArrayBuffer> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    directions.length !== width * height ||
    (packed !== undefined && packed.length !== Math.ceil(directions.length / 8))
  ) {
    throw new Error("LibRaw direction refinement requires a complete plane.");
  }

  const refined = directions;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = refined[index];
      if ((value & 1) === 0) {
        const north = y > 0 ? refined[index - width] : 0;
        const south = y + 1 < height ? refined[index + width] : 0;
        const west = x > 0 ? refined[index - 1] : 0;
        const east = x + 1 < width ? refined[index + 1] : 0;
        const verticalCount =
          Number((north & VER) !== 0) +
          Number((south & VER) !== 0) +
          Number((west & VER) !== 0) +
          Number((east & VER) !== 0);
        const horizontalCount =
          Number((north & HOR) !== 0) +
          Number((south & HOR) !== 0) +
          Number((west & HOR) !== 0) +
          Number((east & HOR) !== 0);
        if ((value & VER) !== 0 && horizontalCount > 3) {
          value = (value & ~VER) | HOR;
        }
        if ((value & HOR) !== 0 && verticalCount > 3) {
          value = (value & ~HOR) | VER;
        }
        refined[index] = value;
      }
      if (packed) packed[index >>> 3] |= (value & 15) << ((index & 7) * 4);
    }
  }
  return refined;
}
