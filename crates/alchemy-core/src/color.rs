pub(crate) const PROPHOTO_D65_TO_V_GAMUT: [[f32; 3]; 3] = [
    [1.139_612_4, -0.008_246_087, -0.131_366_31],
    [-0.023_128_307, 0.933_486_2, 0.089_642_06],
    [0.009_522_688, 0.003_834_068, 0.986_643_25],
];

// Raw Alchemy 0.4.2 treated LibRaw's D65 output as standard D50 ProPhoto and
// asked colour-science to adapt it to V-Gamut. This matrix intentionally
// freezes that historical mistake for the migration-only legacy mode.
pub(crate) const LEGACY_PROPHOTO_D50_TO_V_GAMUT: [[f64; 3]; 3] = [
    [
        1.118_010_835_688_748,
        -0.049_443_321_904_107,
        -0.068_684_599_739_414,
    ],
    [
        -0.026_195_765_214_153,
        0.930_914_054_910_17,
        0.095_305_605_611_064,
    ],
    [
        0.011_479_100_883_736,
        0.006_509_523_387_431,
        0.981_765_875_974_032,
    ],
];

const PROPHOTO_D65_TO_SRGB: [[f32; 3]; 3] = [
    [2.073_830_6, -0.664_746_17, -0.409_084_6],
    [-0.225_335_4, 1.219_972_8, 0.005_362_495],
    [-0.013_918_564, -0.139_463_26, 1.153_381_8],
];

pub(crate) fn multiply_matrix(matrix: &[[f32; 3]; 3], rgb: [f32; 3]) -> [f32; 3] {
    matrix.map(|row| row[0].mul_add(rgb[0], row[1].mul_add(rgb[1], row[2] * rgb[2])))
}

#[allow(clippy::cast_possible_truncation)]
pub(crate) fn multiply_legacy_matrix(rgb: [f32; 3]) -> [f32; 3] {
    LEGACY_PROPHOTO_D50_TO_V_GAMUT.map(|row| {
        (f64::from(rgb[0]) * row[0] + f64::from(rgb[1]) * row[1] + f64::from(rgb[2]) * row[2])
            as f32
    })
}

pub(crate) fn encode_v_log(linear: f32) -> f32 {
    if linear < 0.01 {
        5.6f32.mul_add(linear, 0.125)
    } else {
        0.241_514f32.mul_add((linear + 0.008_73).log10(), 0.598_206)
    }
}

pub(crate) fn render_base(linear_prophoto: [f32; 3]) -> [f32; 3] {
    let linear_srgb = multiply_matrix(&PROPHOTO_D65_TO_SRGB, linear_prophoto);
    let luminance = 0.2126f32.mul_add(
        linear_srgb[0],
        0.7152f32.mul_add(linear_srgb[1], 0.0722 * linear_srgb[2]),
    );

    // A luminance-only shoulder keeps the neutral axis and preserves hue much
    // better than applying a non-linear curve independently to wide-gamut RGB.
    let scale = if luminance > 0.0 {
        1.18 / (0.18 + luminance)
    } else {
        1.0
    };
    linear_srgb.map(|channel| srgb_oetf((channel * scale).max(0.0)))
}

fn srgb_oetf(linear: f32) -> f32 {
    if linear <= 0.003_130_8 {
        linear * 12.92
    } else {
        1.055f32.mul_add(linear.powf(1.0 / 2.4), -0.055)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v_log_keeps_negative_values_on_linear_branch() {
        assert!((encode_v_log(-0.01) - 0.069).abs() < 1.0e-7);
        assert!((encode_v_log(0.0) - 0.125).abs() < f32::EPSILON);
    }

    #[test]
    fn v_log_is_continuous_at_breakpoint() {
        let below = encode_v_log(f32::from_bits(0.01f32.to_bits() - 1));
        let at = encode_v_log(0.01);
        assert!((below - at).abs() < 2.0e-6, "below={below}, at={at}");
    }

    #[test]
    fn d65_neutral_axis_stays_neutral() {
        let converted = multiply_matrix(&PROPHOTO_D65_TO_V_GAMUT, [0.42; 3]);
        for channel in converted {
            assert!((channel - 0.42).abs() < 2.0e-7);
        }
    }
}
