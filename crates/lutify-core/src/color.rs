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
}
