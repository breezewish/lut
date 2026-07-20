use std::sync::OnceLock;

// LibRaw's pinned `prophoto_rgb` constant is the actual linear sRGB-to-output
// transform; the output basis is not nominal ProPhoto primaries merely paired
// with a D65 white point. These matrices are frozen offline from that constant.
// The V-Gamut transform additionally uses Panasonic's published primaries and
// LibRaw's explicit D65 white from `src/tables/colorconst.cpp`.
pub(crate) const LIBRAW_PROPHOTO_D65_TO_V_GAMUT: [[f32; 3]; 3] = [
    [1.115_908_7, -0.042_472_865, -0.073_432_505],
    [-0.028_517_72, 0.936_791_24, 0.091_724_73],
    [0.012_854_77, -0.008_144_919, 0.995_291_2],
];

const LIBRAW_PROPHOTO_D65_TO_SRGB: [[f32; 3]; 3] = [
    [2.034_192_6, -0.727_419_8, -0.306_765_53],
    [-0.228_810_76, 1.231_729_3, -0.002_921_616],
    [-0.008_564_928, -0.153_272_58, 1.161_839],
];

pub(crate) fn multiply_matrix(matrix: &[[f32; 3]; 3], rgb: [f32; 3]) -> [f32; 3] {
    matrix.map(|row| row[0].mul_add(rgb[0], row[1].mul_add(rgb[1], row[2] * rgb[2])))
}

pub(crate) fn encode_v_log(linear: f32) -> f32 {
    if linear < 0.01 {
        5.6f32.mul_add(linear, 0.125)
    } else {
        0.241_514f32.mul_add((linear + 0.008_73).log10(), 0.598_206)
    }
}

pub(crate) fn render_base_preview(linear_libraw_prophoto: [f32; 3]) -> [u8; 3] {
    let linear_srgb = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_SRGB, linear_libraw_prophoto);
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
    linear_srgb.map(|channel| srgb_preview((channel * scale).max(0.0)))
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn srgb_preview(linear: f32) -> u8 {
    static SRGB8: OnceLock<Vec<u8>> = OnceLock::new();
    let table = SRGB8.get_or_init(|| {
        (0..=u16::MAX)
            .map(|code| {
                let encoded = srgb_oetf(f32::from(code) / 65_535.0);
                (encoded * 255.0).round() as u8
            })
            .collect()
    });
    let index = (linear.clamp(0.0, 1.0) * 65_535.0).round() as usize;
    table[index]
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
        let converted = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, [0.42; 3]);
        for channel in converted {
            assert!((channel - 0.42).abs() < 2.0e-6);
        }
    }

    #[test]
    fn d65_matrix_handles_primaries_and_hdr_neutral() {
        let red = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, [1.0, 0.0, 0.0]);
        assert!((red[0] - 1.115_908_7).abs() < f32::EPSILON);
        assert!((red[1] - -0.028_517_72).abs() < f32::EPSILON);
        assert!((red[2] - 0.012_854_77).abs() < f32::EPSILON);

        let green = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, [0.0, 1.0, 0.0]);
        assert!((green[0] - -0.042_472_865).abs() < f32::EPSILON);
        assert!((green[1] - 0.936_791_24).abs() < f32::EPSILON);
        assert!((green[2] - -0.008_144_919).abs() < f32::EPSILON);

        let blue = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, [0.0, 0.0, 1.0]);
        assert!((blue[0] - -0.073_432_505).abs() < f32::EPSILON);
        assert!((blue[1] - 0.091_724_73).abs() < f32::EPSILON);
        assert!((blue[2] - 0.995_291_2).abs() < f32::EPSILON);

        let hdr_neutral = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, [8.0; 3]);
        for channel in hdr_neutral {
            assert!(channel.is_finite());
            assert!((channel - 8.0).abs() < 3.0e-5);
        }
    }

    #[test]
    fn libraw_prophoto_basis_matches_direct_srgb_decode() {
        // Frozen from the pinned LibRaw build by decoding linear.dng once to
        // ProPhoto D65 and once to linear sRGB with otherwise identical settings.
        let samples: [([u16; 3], [u16; 3]); 6] = [
            ([941, 1_567, 1_222], [399, 1_712, 1_171]),
            ([15_676, 15_206, 15_466], [16_084, 15_097, 15_504]),
            ([23_045, 22_026, 22_588], [23_926, 21_791, 22_670]),
            ([35_121, 36_687, 35_822], [33_767, 37_048, 35_696]),
            ([48_527, 50_838, 49_562], [46_529, 51_370, 49_376]),
            ([64_592, 63_966, 64_311], [65_134, 63_821, 64_362]),
        ];

        for (prophoto, expected_srgb) in samples {
            let normalized = prophoto.map(|channel| f32::from(channel) / 65_535.0);
            let actual = multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_SRGB, normalized);
            for channel in 0..3 {
                let actual_code = actual[channel] * 65_535.0;
                let expected_code = f32::from(expected_srgb[channel]);
                assert!(
                    (actual_code - expected_code).abs() <= 2.0,
                    "actual={actual_code}, expected={expected_code}",
                );
            }
        }
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    fn preview_srgb_table_stays_within_one_display_code() {
        for index in 0..1_000_000 {
            let linear = index as f32 / 999_999.0;
            let expected = (srgb_oetf(linear) * 255.0).round() as u8;
            assert!(
                srgb_preview(linear).abs_diff(expected) <= 1,
                "linear={linear}"
            );
        }
    }
}
