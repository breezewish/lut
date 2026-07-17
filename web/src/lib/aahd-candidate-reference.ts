export interface DefectCorrection {
  corrected: Uint16Array;
  defects: Uint32Array;
}

const HOR = 2;
const VER = 4;

/**
 * Scalar reference for the deterministic AAHD defect policy. Every
 * classification and replacement reads the unchanged scaled CFA input.
 */
export function correctImmutableDefects(
  mosaic: Uint16Array,
  width: number,
  height: number,
): DefectCorrection {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    mosaic.length !== width * height
  ) {
    throw new Error("Defect reference requires a complete positive mosaic.");
  }

  const corrected = mosaic.slice();
  const defects = new Uint32Array(Math.ceil(mosaic.length / 32));
  const sample = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height ? mosaic[y * width + x] : 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const center = mosaic[index];
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
      if (!hot && !dead) continue;

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
      if (center >> 4 <= average && center << 4 >= average) continue;

      const horizontal =
        Math.abs(west2 - east2) +
        Math.abs(west - east) +
        Math.abs(west - east + east2 - west2);
      const vertical =
        Math.abs(north2 - south2) +
        Math.abs(north - south) +
        Math.abs(north - south + south2 - north2);
      corrected[index] = Math.trunc(
        vertical > horizontal ? (west2 + east2) / 2 : (north2 + south2) / 2,
      );
      defects[index >>> 5] |= 1 << (index & 31);
    }
  }

  return { corrected, defects };
}

/** Scalar reference for the out-of-place isolated-direction AAHD pass. */
export function refineImmutableIsolatedDirections(
  directions: Uint32Array,
  width: number,
  height: number,
): Uint32Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    directions.length !== width * height
  ) {
    throw new Error("Direction reference requires a complete positive plane.");
  }

  const refined = directions.slice();
  const direction = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height ? directions[y * width + x] : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = directions[index];
      if ((value & 1) !== 0) continue;
      const north = direction(x, y - 1);
      const south = direction(x, y + 1);
      const west = direction(x - 1, y);
      const east = direction(x + 1, y);
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
