import type { SensorImageInfo } from "./sensor-image";

export const XTRANS_TILE_SIZE = 512;
export const XTRANS_TILE_STEP = XTRANS_TILE_SIZE - 16;
export const XTRANS_BORDER = 8;

export interface XtransPattern {
  hexDeltas: Int32Array;
  solitaryGreenRow: number;
  solitaryGreenColumn: number;
}

export interface XtransTile {
  inputX: number;
  inputY: number;
  inputWidth: number;
  inputHeight: number;
  outputX: number;
  outputY: number;
  outputWidth: number;
  outputHeight: number;
}

interface AxisSlice {
  input: number;
  inputLength: number;
  output: number;
  outputLength: number;
}

/** Builds LibRaw's phase-dependent hexagonal neighbors for a 6x6 CFA. */
export function createXtransPattern(
  cfaPattern: readonly number[],
): XtransPattern {
  if (cfaPattern.length !== 36) {
    throw new Error("X-Trans demosaic requires a complete 6x6 CFA pattern.");
  }
  const counts = [0, 0, 0, 0];
  for (const color of cfaPattern) {
    if (!Number.isInteger(color) || color < 0 || color > 2) {
      throw new Error("X-Trans CFA entries must be red, green, or blue.");
    }
    counts[color] += 1;
  }
  if (
    counts[0] < 6 ||
    counts[0] > 10 ||
    counts[1] < 16 ||
    counts[1] > 24 ||
    counts[2] < 6 ||
    counts[2] > 10
  ) {
    throw new Error("X-Trans CFA color counts do not match LibRaw's contract.");
  }

  const orth = [1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1];
  const patterns = [
    [0, 1, 0, -1, 2, 0, -1, 0, 1, 1, 1, -1, 0, 0, 0, 0],
    [0, 1, 0, -2, 1, 0, -2, 0, 1, 1, -2, -2, 1, -1, -1, 1],
  ];
  const hexDeltas = new Int32Array(3 * 3 * 8 * 2);
  hexDeltas.fill(32700);
  let solitaryGreenRow = -1;
  let solitaryGreenColumn = -1;
  const colorAt = (row: number, column: number) =>
    cfaPattern[modulo(row, 6) * 6 + modulo(column, 6)];

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const green = colorAt(row, column) === 1 ? 1 : 0;
      let nonGreenNeighbors = 0;
      for (let direction = 0; direction < 10; direction += 2) {
        if (
          colorAt(row + orth[direction], column + orth[direction + 2]) === 1
        ) {
          nonGreenNeighbors = 0;
        } else {
          nonGreenNeighbors += 1;
        }
        if (nonGreenNeighbors === 4) {
          solitaryGreenRow = row;
          solitaryGreenColumn = column;
        }
        if (nonGreenNeighbors !== green + 1) continue;
        for (let neighbor = 0; neighbor < 8; neighbor += 1) {
          const vertical =
            orth[direction] * patterns[green][neighbor * 2] +
            orth[direction + 1] * patterns[green][neighbor * 2 + 1];
          const horizontal =
            orth[direction + 2] * patterns[green][neighbor * 2] +
            orth[direction + 3] * patterns[green][neighbor * 2 + 1];
          const target = neighbor ^ ((green * 2) & direction);
          const base = ((row * 3 + column) * 8 + target) * 2;
          hexDeltas[base] = horizontal;
          hexDeltas[base + 1] = vertical;
        }
      }
    }
  }
  if (
    solitaryGreenRow < 0 ||
    solitaryGreenColumn < 0 ||
    hexDeltas.some((value) => value === 32700)
  ) {
    throw new Error("X-Trans CFA does not produce LibRaw's hexagonal map.");
  }
  return { hexDeltas, solitaryGreenRow, solitaryGreenColumn };
}

/** Reproduces LibRaw's 512px Markesteijn tile coverage without overlap writes. */
export function createXtransTiles(width: number, height: number): XtransTile[] {
  const columns = createAxisSlices(width);
  const rows = createAxisSlices(height);
  return rows.flatMap((row) =>
    columns.map((column) => ({
      inputX: column.input,
      inputY: row.input,
      inputWidth: column.inputLength,
      inputHeight: row.inputLength,
      outputX: column.output,
      outputY: row.output,
      outputWidth: column.outputLength,
      outputHeight: row.outputLength,
    })),
  );
}

export function validateXtransInput(info: SensorImageInfo): XtransPattern {
  if (
    info.sensorType !== "xtrans" ||
    info.cfaSize !== 6 ||
    info.sampleCount !== info.width * info.height ||
    info.width < XTRANS_TILE_SIZE ||
    info.height < XTRANS_TILE_SIZE ||
    info.orientation !== 0
  ) {
    throw new Error(
      "WebGPU X-Trans requires an unrotated, complete 6x6 sensor mosaic.",
    );
  }
  if (
    !Number.isFinite(info.demosaicScaleRange) ||
    info.demosaicScaleRange <= 0 ||
    info.demosaicPreMultipliers.length !== 4 ||
    info.demosaicPreMultipliers.some(
      (multiplier) => !Number.isFinite(multiplier) || multiplier <= 0,
    ) ||
    info.xtransLabMatrix.length !== 9 ||
    info.librawProPhotoMatrix.length !== 12
  ) {
    throw new Error("LibRaw returned invalid X-Trans processing metadata.");
  }
  return createXtransPattern(info.cfaPattern);
}

function createAxisSlices(length: number): AxisSlice[] {
  if (!Number.isInteger(length) || length < XTRANS_TILE_SIZE) {
    throw new Error("X-Trans tile dimensions must be at least 512 pixels.");
  }
  const slices: AxisSlice[] = [];
  let covered = 0;
  for (let input = 3; input < length - 19; input += XTRANS_TILE_STEP) {
    const inputEnd = Math.min(input + XTRANS_TILE_SIZE, length - 3);
    const inputLength = inputEnd - input;
    const interiorStart = Math.max(
      XTRANS_BORDER,
      input + Math.min(input, XTRANS_BORDER),
    );
    const libRawEnd =
      length - input < XTRANS_TILE_SIZE + 4
        ? length - 6
        : input + inputLength - XTRANS_BORDER;
    const interiorEnd = Math.min(length - XTRANS_BORDER, libRawEnd);
    const output = slices.length === 0 ? 0 : interiorStart;
    const outputEnd =
      interiorEnd === length - XTRANS_BORDER ? length : interiorEnd;
    if (output !== covered || outputEnd <= output) {
      throw new Error("X-Trans tile coverage is incomplete.");
    }
    slices.push({
      input,
      inputLength,
      output,
      outputLength: outputEnd - output,
    });
    covered = outputEnd;
  }
  if (covered !== length) {
    throw new Error("X-Trans tiles do not cover the complete image.");
  }
  return slices;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
