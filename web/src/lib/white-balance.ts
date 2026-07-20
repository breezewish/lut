import type { WhiteBalanceValues } from "../types";

const D65_CCT = 6504;
const D65_XY = [0.3127, 0.329] as const;
const TINT_DUV_PER_STEP = -0.0005;

const PLANCK_U = [
  0.20042808258946535, 0.021670127838210658, 0.004941279052065094,
  -0.0008090840314764964, -0.00011318638614341891, 0.0001065014881380249,
  -0.000029459270200989892, -0.000002902435510008949, 0.00000572817056676121,
  -0.0000012719911614227974, -0.0000002565272318851006,
] as const;
const PLANCK_V = [
  0.31033342890275567, 0.029893630533631914, -0.0044257853388274,
  -0.0013099604266659877, 0.0008113359906466061, -0.00018080749013704164,
  -0.000019086191775832478, 0.00003585686520700713, -0.000013826413811352124,
  -0.000000675784317713839, 0.0000017403410985881575,
] as const;
const PLANCK_TANGENT_U = [
  0.5869182180956649, 0.2893814826648264, -0.019287578494842157,
  -0.03623096990279516, 0.007623792870567206, 0.0030520940866540953,
  -0.0010403026324977203, -0.00018529622788312033, 0.00008666191184300517,
  0.000008512881065854595, -0.000003949015108301125,
] as const;
const PLANCK_TANGENT_V = [
  0.8096462223108812, -0.20977465709442028, -0.06490896492751604,
  0.016340113139321086, 0.008825176667254188, -0.002203072113364394,
  -0.0009946316564358089, 0.0003055469538525697, 0.00007673679846535353,
  -0.000026349176456116718, -0.0000031870682560505213,
] as const;

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
] as const;
const BRADFORD_INVERSE = [
  [0.9869929054667123, -0.14705425642099013, 0.15996265166373125],
  [0.4323052697233945, 0.5183602715367776, 0.049291228212855594],
  [-0.008528664575177328, 0.04004282165408487, 0.96848669578755],
] as const;
const PROPHOTO_D65_TO_XYZ = [
  [0.755603256421359, 0.11278492113801272, 0.08208189343532289],
  [0.2683379250450128, 0.7151267706955571, 0.016535310335320977],
  [0.003910020350449157, -0.012918708286404542, 1.0978387753557597],
] as const;
const XYZ_TO_PROPHOTO_D65 = [
  [1.4032152671158387, -0.22314009767162846, -0.10155304928343209],
  [-0.5262714954210982, 1.4816610915442805, 0.017031312123848466],
  [-0.011190484846281556, 0.018230026296336695, 0.9114426630797009],
] as const;

type MatrixRow = readonly [number, number, number];
type Matrix = readonly [MatrixRow, MatrixRow, MatrixRow];

/** Builds Studio-compatible relative Bradford adaptation in linear ProPhoto D65. */
export function whiteBalanceMatrix({
  temperature,
  tint,
}: WhiteBalanceValues): Float32Array {
  if (
    !Number.isFinite(temperature) ||
    !Number.isFinite(tint) ||
    temperature < -100 ||
    temperature > 100 ||
    tint < -100 ||
    tint > 100
  ) {
    throw new Error(
      "White balance temperature and tint must be within -100..=100.",
    );
  }
  if (temperature === 0 && tint === 0) {
    return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  const targetMired = 1_000_000 / D65_CCT + temperature;
  const cct = 1_000_000 / targetMired;
  const uv = planckUvWithDuv(cct, tint * TINT_DUV_PER_STEP);
  const denominator = 2 * uv[0] - 8 * uv[1] + 4;
  const targetXy: [number, number] = [
    (3 * uv[0]) / denominator,
    (2 * uv[1]) / denominator,
  ];
  const adaptation = chromaticAdaptation(xyToXyz(D65_XY), xyToXyz(targetXy));
  return new Float32Array(
    multiplyMatrices(
      multiplyMatrices(XYZ_TO_PROPHOTO_D65, adaptation),
      PROPHOTO_D65_TO_XYZ,
    ).flat(),
  );
}

/** Writes a row-major 3×3 matrix as three WGSL-aligned vec4 rows. */
export function writeWhiteBalanceUniform(
  view: DataView,
  offset: number,
  matrix: Float32Array,
): void {
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      view.setFloat32(
        offset + row * 16 + column * 4,
        matrix[row * 3 + column],
        true,
      );
    }
  }
}

function planckUvWithDuv(cct: number, duv: number): [number, number] {
  const uv = planckUv(cct);
  const x = (1_000_000 / cct - 1_000_000 / D65_CCT) / 100;
  const du = polynomial(PLANCK_TANGENT_U, x);
  const dv = polynomial(PLANCK_TANGENT_V, x);
  const length = Math.hypot(du, dv);
  return [uv[0] - (duv * dv) / length, uv[1] + (duv * du) / length];
}

function planckUv(cct: number): [number, number] {
  const x = (1_000_000 / cct - 1_000_000 / D65_CCT) / 100;
  return [polynomial(PLANCK_U, x), polynomial(PLANCK_V, x)];
}

function polynomial(coefficients: readonly number[], x: number): number {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    result = result * x + coefficients[index];
  }
  return result;
}

function xyToXyz(xy: readonly [number, number]): [number, number, number] {
  return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]];
}

function chromaticAdaptation(
  source: [number, number, number],
  target: [number, number, number],
): [MatrixRow, MatrixRow, MatrixRow] {
  const sourceCone = multiplyVector(BRADFORD, source);
  const targetCone = multiplyVector(BRADFORD, target);
  const scale: Matrix = [
    [targetCone[0] / sourceCone[0], 0, 0],
    [0, targetCone[1] / sourceCone[1], 0],
    [0, 0, targetCone[2] / sourceCone[2]],
  ];
  return multiplyMatrices(multiplyMatrices(BRADFORD_INVERSE, scale), BRADFORD);
}

function multiplyVector(
  matrix: Matrix,
  vector: [number, number, number],
): [number, number, number] {
  return matrix.map(
    (row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2],
  ) as [number, number, number];
}

function multiplyMatrices(
  left: Matrix,
  right: Matrix,
): [MatrixRow, MatrixRow, MatrixRow] {
  const productRow = (row: number): MatrixRow => [
    left[row][0] * right[0][0] +
      left[row][1] * right[1][0] +
      left[row][2] * right[2][0],
    left[row][0] * right[0][1] +
      left[row][1] * right[1][1] +
      left[row][2] * right[2][1],
    left[row][0] * right[0][2] +
      left[row][1] * right[1][2] +
      left[row][2] * right[2][2],
  ];
  return [productRow(0), productRow(1), productRow(2)];
}
