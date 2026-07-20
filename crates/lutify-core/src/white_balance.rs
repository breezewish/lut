use crate::{LutifyError, Result};

const D65_CCT: f64 = 6504.0;
const D65_XY: [f64; 2] = [0.3127, 0.3290];
const TINT_DUV_PER_STEP: f64 = -0.0005;

// Degree-10 least-squares fits of colour-science's CIE 1931 2° Planckian
// locus over LUTify's complete -100..=100 mired interval. The independent
// Studio fixture constrains the resulting Bradford matrices to 1e-6.
const PLANCK_U: [f64; 11] = [
    0.200_428_082_589_465_35,
    0.021_670_127_838_210_658,
    0.004_941_279_052_065_094,
    -0.000_809_084_031_476_496_4,
    -0.000_113_186_386_143_418_91,
    0.000_106_501_488_138_024_9,
    -0.000_029_459_270_200_989_892,
    -0.000_002_902_435_510_008_949,
    0.000_005_728_170_566_761_21,
    -0.000_001_271_991_161_422_797_4,
    -0.000_000_256_527_231_885_100_6,
];
const PLANCK_V: [f64; 11] = [
    0.310_333_428_902_755_67,
    0.029_893_630_533_631_914,
    -0.004_425_785_338_827_4,
    -0.001_309_960_426_665_987_7,
    0.000_811_335_990_646_606_1,
    -0.000_180_807_490_137_041_64,
    -0.000_019_086_191_775_832_478,
    0.000_035_856_865_207_007_13,
    -0.000_013_826_413_811_352_124,
    -0.000_000_675_784_317_713_839,
    0.000_001_740_341_098_588_157_5,
];
const PLANCK_TANGENT_U: [f64; 11] = [
    0.586_918_218_095_664_9,
    0.289_381_482_664_826_4,
    -0.019_287_578_494_842_157,
    -0.036_230_969_902_795_16,
    0.007_623_792_870_567_206,
    0.003_052_094_086_654_095_3,
    -0.001_040_302_632_497_720_3,
    -0.000_185_296_227_883_120_33,
    0.000_086_661_911_843_005_17,
    0.000_008_512_881_065_854_595,
    -0.000_003_949_015_108_301_125,
];
const PLANCK_TANGENT_V: [f64; 11] = [
    0.809_646_222_310_881_2,
    -0.209_774_657_094_420_28,
    -0.064_908_964_927_516_04,
    0.016_340_113_139_321_086,
    0.008_825_176_667_254_188,
    -0.002_203_072_113_364_394,
    -0.000_994_631_656_435_808_9,
    0.000_305_546_953_852_569_7,
    0.000_076_736_798_465_353_53,
    -0.000_026_349_176_456_116_718,
    -0.000_003_187_068_256_050_521_3,
];

const BRADFORD: [[f64; 3]; 3] = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INVERSE: [[f64; 3]; 3] = [
    [
        0.986_992_905_466_712_3,
        -0.147_054_256_420_990_13,
        0.159_962_651_663_731_25,
    ],
    [
        0.432_305_269_723_394_5,
        0.518_360_271_536_777_6,
        0.049_291_228_212_855_594,
    ],
    [
        -0.008_528_664_575_177_328,
        0.040_042_821_654_084_87,
        0.968_486_695_787_55,
    ],
];
const PROPHOTO_D65_TO_XYZ: [[f64; 3]; 3] = [
    [
        0.755_603_256_421_359,
        0.112_784_921_138_012_72,
        0.082_081_893_435_322_89,
    ],
    [
        0.268_337_925_045_012_8,
        0.715_126_770_695_557_1,
        0.016_535_310_335_320_977,
    ],
    [
        0.003_910_020_350_449_157,
        -0.012_918_708_286_404_542,
        1.097_838_775_355_759_7,
    ],
];
const XYZ_TO_PROPHOTO_D65: [[f64; 3]; 3] = [
    [
        1.403_215_267_115_838_7,
        -0.223_140_097_671_628_46,
        -0.101_553_049_283_432_09,
    ],
    [
        -0.526_271_495_421_098_2,
        1.481_661_091_544_280_5,
        0.017_031_312_123_848_466,
    ],
    [
        -0.011_190_484_846_281_556,
        0.018_230_026_296_336_695,
        0.911_442_663_079_700_9,
    ],
];

/// Relative white-balance recipe applied after the camera's As Shot balance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WhiteBalance {
    pub(crate) matrix: [[f32; 3]; 3],
}

impl WhiteBalance {
    /// Creates relative Temperature and Tint adjustments in `-100..=100`.
    /// Zero on both axes is an exact identity transform.
    ///
    /// # Errors
    ///
    /// Returns [`LutifyError::InvalidWhiteBalance`] for non-finite or
    /// out-of-range values.
    pub fn new(temperature: f32, tint: f32) -> Result<Self> {
        if !temperature.is_finite()
            || !tint.is_finite()
            || !(-100.0..=100.0).contains(&temperature)
            || !(-100.0..=100.0).contains(&tint)
        {
            return Err(LutifyError::InvalidWhiteBalance);
        }
        if temperature == 0.0 && tint == 0.0 {
            return Ok(Self::as_shot());
        }

        let target_mired = 1_000_000.0 / D65_CCT + f64::from(temperature);
        let cct = 1_000_000.0 / target_mired;
        let uv = planck_uv_with_duv(cct, f64::from(tint) * TINT_DUV_PER_STEP);
        let denominator = 2.0 * uv[0] - 8.0 * uv[1] + 4.0;
        let target_xy = [3.0 * uv[0] / denominator, 2.0 * uv[1] / denominator];
        let cat = chromatic_adaptation(xy_to_xyz(D65_XY), xy_to_xyz(target_xy));
        let matrix = multiply_matrices(
            &multiply_matrices(&XYZ_TO_PROPHOTO_D65, &cat),
            &PROPHOTO_D65_TO_XYZ,
        );
        // WebGPU and the pixel pipeline consume f32. Matrix construction stays
        // in f64 so the only precision reduction happens at this boundary.
        #[allow(clippy::cast_possible_truncation)]
        let matrix = matrix.map(|row| row.map(|value| value as f32));
        Ok(Self { matrix })
    }

    /// Returns the camera's As Shot balance with no relative correction.
    #[must_use]
    pub const fn as_shot() -> Self {
        Self {
            matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        }
    }
}

fn planck_uv_with_duv(cct: f64, duv: f64) -> [f64; 2] {
    let uv = planck_uv(cct);
    let x = ((1_000_000.0 / cct) - 1_000_000.0 / D65_CCT) / 100.0;
    let du = polynomial(&PLANCK_TANGENT_U, x);
    let dv = polynomial(&PLANCK_TANGENT_V, x);
    let length = du.hypot(dv);
    [uv[0] - duv * dv / length, uv[1] + duv * du / length]
}

fn planck_uv(cct: f64) -> [f64; 2] {
    let x = ((1_000_000.0 / cct) - 1_000_000.0 / D65_CCT) / 100.0;
    [polynomial(&PLANCK_U, x), polynomial(&PLANCK_V, x)]
}

fn polynomial(coefficients: &[f64], x: f64) -> f64 {
    coefficients
        .iter()
        .rev()
        .fold(0.0, |result, coefficient| result.mul_add(x, *coefficient))
}

fn xy_to_xyz(xy: [f64; 2]) -> [f64; 3] {
    [xy[0] / xy[1], 1.0, (1.0 - xy[0] - xy[1]) / xy[1]]
}

fn chromatic_adaptation(source: [f64; 3], target: [f64; 3]) -> [[f64; 3]; 3] {
    let source_cone = multiply_vector(&BRADFORD, source);
    let target_cone = multiply_vector(&BRADFORD, target);
    let scale = [
        [target_cone[0] / source_cone[0], 0.0, 0.0],
        [0.0, target_cone[1] / source_cone[1], 0.0],
        [0.0, 0.0, target_cone[2] / source_cone[2]],
    ];
    multiply_matrices(&multiply_matrices(&BRADFORD_INVERSE, &scale), &BRADFORD)
}

fn multiply_vector(matrix: &[[f64; 3]; 3], vector: [f64; 3]) -> [f64; 3] {
    matrix.map(|row| row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2])
}

fn multiply_matrices(left: &[[f64; 3]; 3], right: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|row| {
        std::array::from_fn(|column| {
            left[row][0] * right[0][column]
                + left[row][1] * right[1][column]
                + left[row][2] * right[2][column]
        })
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    const STUDIO_REFERENCE: &str =
        include_str!("../../../tests/fixtures/studio-white-balance-reference.json");

    #[derive(Deserialize)]
    struct Reference {
        studio_commit: String,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        temperature: f32,
        tint: f32,
        matrix: [[f64; 3]; 3],
    }

    #[test]
    fn matrices_match_raw_alchemy_studio() {
        let reference: Reference = serde_json::from_str(STUDIO_REFERENCE).unwrap();
        assert_eq!(
            reference.studio_commit,
            "c9823146ba674be52d62f4c55b4c649f796bafd0"
        );
        for case in reference.cases {
            let actual = WhiteBalance::new(case.temperature, case.tint)
                .unwrap()
                .matrix;
            for (row, actual_row) in actual.iter().enumerate() {
                for (column, actual_value) in actual_row.iter().enumerate() {
                    assert!(
                        (f64::from(*actual_value) - case.matrix[row][column]).abs() < 1.0e-6,
                        "({}, {}) [{row}][{column}] actual={} expected={}",
                        case.temperature,
                        case.tint,
                        actual_value,
                        case.matrix[row][column],
                    );
                }
            }
        }
    }

    #[test]
    fn as_shot_is_exact_and_invalid_values_are_rejected() {
        assert_eq!(
            WhiteBalance::new(0.0, 0.0).unwrap(),
            WhiteBalance::as_shot()
        );
        assert_eq!(
            WhiteBalance::new(100.1, 0.0).unwrap_err(),
            LutifyError::InvalidWhiteBalance
        );
        assert_eq!(
            WhiteBalance::new(0.0, f32::NAN).unwrap_err(),
            LutifyError::InvalidWhiteBalance
        );
    }
}
