use crate::color::{LIBRAW_PROPHOTO_D65_TO_V_GAMUT, encode_v_log, multiply_matrix};
use crate::image::checked_pixel_count;
use crate::{Lut3d, LutifyError, Result, tiff};

/// Immutable native corrected-v2 TIFF recipe.
#[derive(Clone, Debug)]
pub struct ColorPipeline {
    exposure_multiplier: f32,
    lut: Lut3d,
}

impl ColorPipeline {
    /// Creates a pipeline. EV is intentionally bounded to keep mistakes visible
    /// and avoid non-finite multipliers.
    ///
    /// # Errors
    ///
    /// Returns [`LutifyError::InvalidExposure`] when EV is not finite or is
    /// outside the supported range.
    pub fn new(ev: f32, lut: Lut3d) -> Result<Self> {
        if !ev.is_finite() || !(-12.0..=12.0).contains(&ev) {
            return Err(LutifyError::InvalidExposure);
        }
        Ok(Self {
            exposure_multiplier: ev.exp2(),
            lut,
        })
    }

    /// Renders an uncompressed 16-bit RGB TIFF. Processing is fused into bounded
    /// strips, so no full-size float or quantized image is retained.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid image input or encoder failure.
    pub fn render_tiff(&self, pixels: &[u16], width: u32, height: u32) -> Result<Vec<u8>> {
        validate_image(pixels, width, height)?;
        tiff::encode_rgb16_strips(width, height, |range, output| {
            self.render_rgb16_strip(&pixels[range], output);
            Ok(())
        })
    }

    fn render_rgb16_strip(&self, pixels: &[u16], output: &mut Vec<u16>) {
        for input in pixels.chunks_exact(3) {
            output.extend(self.render_lut(self.input_pixel(input)).map(quantize_u16));
        }
    }

    fn input_pixel(&self, input: &[u16]) -> [f32; 3] {
        [
            f32::from(input[0]) / 65_535.0 * self.exposure_multiplier,
            f32::from(input[1]) / 65_535.0 * self.exposure_multiplier,
            f32::from(input[2]) / 65_535.0 * self.exposure_multiplier,
        ]
    }

    fn render_lut(&self, linear_libraw_prophoto: [f32; 3]) -> [f32; 3] {
        let linear_v_gamut =
            multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, linear_libraw_prophoto);
        let vlog = linear_v_gamut.map(encode_v_log);
        self.lut.sample(vlog)
    }
}

pub(crate) fn validate_image(pixels: &[u16], width: u32, height: u32) -> Result<()> {
    let pixel_count = checked_pixel_count(width, height)?;
    let expected = pixel_count
        .checked_mul(3)
        .ok_or(LutifyError::ImageTooLarge)?;
    if pixels.len() != expected {
        return Err(LutifyError::InvalidPixelCount {
            actual: pixels.len(),
            expected,
        });
    }
    Ok(())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn quantize_u16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * 65_535.0).round() as u16
}

#[cfg(test)]
mod tests {
    use ::tiff::{
        ColorType,
        decoder::{Decoder, DecodingResult},
        tags::CompressionMethod,
    };
    use serde::Deserialize;
    use std::io::Cursor;

    use super::*;

    const IDENTITY_2: &str =
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    const CORRECTED_REFERENCE: &str =
        include_str!("../../../tests/fixtures/corrected-v2-reference.json");

    #[derive(Deserialize)]
    struct CorrectedReference {
        schema_version: u32,
        cube: String,
        cases: Vec<CorrectedReferenceCase>,
    }

    #[derive(Deserialize)]
    struct CorrectedReferenceCase {
        name: String,
        ev: f32,
        width: u32,
        height: u32,
        pixels: Vec<u16>,
        lut_rgb16: Vec<u16>,
    }

    #[test]
    fn exposure_supports_both_documented_boundaries() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let minimum = ColorPipeline::new(-12.0, lut.clone()).unwrap();
        let maximum = ColorPipeline::new(12.0, lut).unwrap();
        let pixels = [32_768; 3];
        let minimum_linear = minimum.input_pixel(&pixels);
        let maximum_linear = maximum.input_pixel(&pixels);

        assert!(minimum_linear.iter().all(|channel| channel.is_finite()));
        assert!(maximum_linear.iter().all(|channel| channel.is_finite()));
        assert!(maximum_linear[0] > minimum_linear[0]);
    }

    #[test]
    fn rejects_invalid_dimensions_and_exposure() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        assert_eq!(
            ColorPipeline::new(f32::NAN, lut.clone()).unwrap_err(),
            LutifyError::InvalidExposure
        );
        assert_eq!(
            ColorPipeline::new(f32::INFINITY, lut.clone()).unwrap_err(),
            LutifyError::InvalidExposure
        );
        assert_eq!(
            ColorPipeline::new(12.1, lut.clone()).unwrap_err(),
            LutifyError::InvalidExposure
        );
        assert!(matches!(
            ColorPipeline::new(0.0, lut)
                .unwrap()
                .render_tiff(&[0; 3], 2, 1),
            Err(LutifyError::InvalidPixelCount { .. })
        ));
    }

    #[test]
    fn quantization_rounds_and_clamps_explicitly() {
        assert_eq!(quantize_u16(-1.0), 0);
        assert_eq!(quantize_u16(0.5), 32_768);
        assert_eq!(quantize_u16(2.0), 65_535);
    }

    #[test]
    fn corrected_pipeline_matches_independent_float64_reference() {
        let reference: CorrectedReference = serde_json::from_str(CORRECTED_REFERENCE).unwrap();
        assert_eq!(reference.schema_version, 1);
        let lut = Lut3d::parse(&reference.cube).unwrap();

        for case in reference.cases {
            let pipeline = ColorPipeline::new(case.ev, lut.clone()).unwrap();
            let encoded = pipeline
                .render_tiff(&case.pixels, case.width, case.height)
                .unwrap();
            let mut decoder = Decoder::new(Cursor::new(encoded)).unwrap();
            assert_eq!(decoder.dimensions().unwrap(), (case.width, case.height));
            assert_eq!(decoder.colortype().unwrap(), ColorType::RGB(16));
            assert_eq!(
                decoder
                    .get_tag_unsigned::<u16>(::tiff::tags::Tag::Compression)
                    .unwrap(),
                CompressionMethod::None.to_u16()
            );
            let DecodingResult::U16(tiff_rgb16) = decoder.read_image().unwrap() else {
                panic!("{} TIFF did not decode to RGB16", case.name);
            };
            assert_code_values_close(&case.name, &tiff_rgb16, &case.lut_rgb16);
        }
    }

    fn assert_code_values_close<T>(label: &str, actual: &[T], expected: &[T])
    where
        T: Copy + std::fmt::Debug + Ord + std::ops::Sub<Output = T> + From<u8>,
    {
        assert_eq!(actual.len(), expected.len(), "{label}");
        for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
            let difference = if actual >= expected {
                *actual - *expected
            } else {
                *expected - *actual
            };
            assert!(
                difference <= T::from(1),
                "{label} differs at {index}: actual={actual:?}, expected={expected:?}"
            );
        }
    }
}
