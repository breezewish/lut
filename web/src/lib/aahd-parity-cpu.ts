export interface LibRawDefectCorrection {
  corrected: Uint16Array<ArrayBuffer>;
  defects: Uint32Array<ArrayBuffer>;
}

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

/** Computes LibRaw AAHD's signed YUV int3 values as packed 16-bit samples. */
export function createLibRawYuvReference(
  rgb: Uint16Array,
  matrix: readonly number[],
): Uint16Array<ArrayBuffer> {
  if (rgb.length % 3 !== 0 || matrix.length !== 9) {
    throw new Error(
      "AAHD YUV reference requires RGB triples and a 3x3 matrix.",
    );
  }
  const gamma = createLibRawGammaLut();
  const result = new Uint16Array(rgb.length);
  for (let index = 0; index < rgb.length; index += 3) {
    const red = Math.trunc(gamma[rgb[index]]);
    const green = Math.trunc(gamma[rgb[index + 1]]);
    const blue = Math.trunc(gamma[rgb[index + 2]]);
    for (let row = 0; row < 3; row += 1) {
      const first = Math.fround(matrix[row * 3] * red);
      const second = Math.fround(matrix[row * 3 + 1] * green);
      const third = Math.fround(matrix[row * 3 + 2] * blue);
      result[index + row] = Math.trunc(
        Math.fround(Math.fround(first + second) + third),
      );
    }
  }
  return result;
}

/**
 * Reproduces LibRaw AAHD's ordered CFA scaling and hot/dead-pixel scan.
 * Later pixels intentionally observe corrections made earlier in row order.
 */
export function correctLibRawSerialDefects(
  mosaic: Uint16Array,
  width: number,
  height: number,
  cfaPattern: ArrayLike<number>,
  blackLevels: number[],
  scaleMultipliers: Float32Array,
): LibRawDefectCorrection {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    mosaic.length !== width * height ||
    cfaPattern.length !== 4 ||
    blackLevels.length !== 4 ||
    scaleMultipliers.length !== 4
  ) {
    throw new Error(
      "LibRaw defect correction requires a complete Bayer mosaic.",
    );
  }

  const margin = 4;
  const stride = width + margin * 2;
  const working = new Uint16Array(stride * (height + margin * 2));
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width;
    const workingRow = (y + margin) * stride + margin;
    for (let x = 0; x < width; x += 1) {
      const cfa = cfaPattern[(y & 1) * 2 + (x & 1)];
      const channel = cfa === 3 ? 1 : cfa;
      const value = Math.fround(mosaic[sourceRow + x] - blackLevels[channel]);
      const scaled = Math.fround(value * scaleMultipliers[channel]);
      working[workingRow + x] = Math.trunc(
        Math.min(65535, Math.max(0, scaled)),
      );
    }
  }

  const defects = new Uint32Array(Math.ceil(mosaic.length / 32));
  const correctParity = (y: number, start: number) => {
    const row = (y + margin) * stride + margin;
    for (let x = start; x < width; x += 2) {
      const offset = row + x;
      const center = working[offset];
      const west2 = working[offset - 2];
      const east2 = working[offset + 2];
      const north2 = working[offset - 2 * stride];
      const south2 = working[offset + 2 * stride];
      const west = working[offset - 1];
      const east = working[offset + 1];
      const north = working[offset - stride];
      const south = working[offset + stride];
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
      if (!hot && !dead) continue;

      const average = Math.trunc(
        (working[offset - 2 * stride - 2] +
          north2 +
          working[offset - 2 * stride + 2] +
          west2 +
          east2 +
          working[offset + 2 * stride - 2] +
          south2 +
          working[offset + 2 * stride + 2]) /
          8,
      );
      if (center >> 4 <= average && center << 4 >= average) continue;

      const horizontal =
        Math.abs(west2 - east2) +
        Math.abs(west - east) +
        Math.abs(west - east + east2 - west2);
      const vertical =
        Math.abs(north2 - south2) +
        Math.abs(north - south) +
        Math.abs(north - south + south2 - north2);
      working[offset] = Math.trunc(
        vertical > horizontal ? (west2 + east2) / 2 : (north2 + south2) / 2,
      );
      const index = y * width + x;
      defects[index >>> 5] |= 1 << (index & 31);
    }
  };

  for (let y = 0; y < height; y += 1) {
    const firstChannel = cfaPattern[(y & 1) * 2];
    const nonGreenStart = (firstChannel === 3 ? 1 : firstChannel) & 1;
    correctParity(y, nonGreenStart);
    correctParity(y, nonGreenStart ^ 1);
  }

  const corrected = new Uint16Array(mosaic.length);
  for (let y = 0; y < height; y += 1) {
    const row = (y + margin) * stride + margin;
    corrected.set(working.subarray(row, row + width), y * width);
  }
  return { corrected, defects };
}

/** Reproduces LibRaw AAHD's final ordered isolated-direction scan. */
export function refineLibRawSerialDirections(
  directions: Uint16Array,
  width: number,
  height: number,
): Uint16Array<ArrayBuffer> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    directions.length !== width * height
  ) {
    throw new Error("LibRaw direction refinement requires a complete plane.");
  }

  const refined = new Uint16Array(directions.length);
  refined.set(directions);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = refined[index];
      if ((value & 1) !== 0) continue;
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
  }
  return refined;
}
