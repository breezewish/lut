use crate::color::{
    LIBRAW_PROPHOTO_D65_TO_V_GAMUT, encode_v_log, multiply_matrix, render_base_preview,
};
use crate::image::{checked_pixel_count, preview_dimensions};
use crate::{Lut3d, LutifyError, Result, tiff};

/// Immutable processing recipe shared by preview and export.
#[derive(Clone, Debug)]
pub struct ColorPipeline {
    exposure_multiplier: f32,
    lut: Lut3d,
}

/// Both preview views rendered from the same decoded input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    pub base_rgba: Vec<u8>,
    pub lut_rgba: Vec<u8>,
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

    /// Renders base and LUT previews while downsampling directly from RGB16.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid dimensions, pixel count, or preview size.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    pub fn render_preview(
        &self,
        pixels: &[u16],
        width: u32,
        height: u32,
        max_edge: u32,
    ) -> Result<Preview> {
        validate_image(pixels, width, height)?;
        let (output_width, output_height) = preview_dimensions(width, height, max_edge)?;
        let output_pixels = checked_pixel_count(output_width, output_height)?;
        let mut base_rgba = vec![0; output_pixels * 4];
        let mut lut_rgba = vec![0; output_pixels * 4];

        for output_y in 0..output_height {
            let source_y =
                (u64::from(output_y) * u64::from(height) / u64::from(output_height)) as u32;
            for output_x in 0..output_width {
                let source_x =
                    (u64::from(output_x) * u64::from(width) / u64::from(output_width)) as u32;
                let source = (source_y as usize * width as usize + source_x as usize) * 3;
                let target = (output_y as usize * output_width as usize + output_x as usize) * 4;
                let linear = self.input_pixel(&pixels[source..source + 3]);
                write_rgba8(
                    &mut base_rgba[target..target + 4],
                    render_base_preview(linear),
                );
                write_rgba(&mut lut_rgba[target..target + 4], self.render_lut(linear));
            }
        }

        Ok(Preview {
            width: output_width,
            height: output_height,
            base_rgba,
            lut_rgba,
        })
    }

    /// Renders display-referred RGB16 for TIFF export without allocating an
    /// intermediate float image.
    ///
    /// # Errors
    ///
    /// Returns an error when dimensions and pixel count disagree.
    pub fn render_rgb16(&self, pixels: &[u16], width: u32, height: u32) -> Result<Vec<u16>> {
        validate_image(pixels, width, height)?;
        let mut output = Vec::with_capacity(pixels.len());
        self.render_rgb16_strip(pixels, &mut output);
        Ok(output)
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

    pub(crate) fn render_rgb16_strip(&self, pixels: &[u16], output: &mut Vec<u16>) {
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

fn write_rgba(output: &mut [u8], rgb: [f32; 3]) {
    for channel in 0..3 {
        output[channel] = quantize_u8(rgb[channel]);
    }
    output[3] = 255;
}

fn write_rgba8(output: &mut [u8], rgb: [u8; 3]) {
    output[..3].copy_from_slice(&rgb);
    output[3] = 255;
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn quantize_u8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
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
        base_rgba: Vec<u8>,
        lut_rgba: Vec<u8>,
        lut_rgb16: Vec<u16>,
    }

    #[test]
    fn exposure_is_applied_to_both_views() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let zero = ColorPipeline::new(0.0, lut.clone()).unwrap();
        let plus_one = ColorPipeline::new(1.0, lut).unwrap();
        let pixels = [8_000, 10_000, 12_000];
        let base_zero = zero.render_preview(&pixels, 1, 1, 1).unwrap();
        let base_plus_one = plus_one.render_preview(&pixels, 1, 1, 1).unwrap();
        assert!(base_plus_one.base_rgba[1] > base_zero.base_rgba[1]);
        assert!(base_plus_one.lut_rgba[1] > base_zero.lut_rgba[1]);
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
    fn preview_downsamples_without_changing_aspect_ratio() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let pipeline = ColorPipeline::new(0.0, lut).unwrap();
        let preview = pipeline
            .render_preview(&vec![0; 400 * 200 * 3], 400, 200, 100)
            .unwrap();
        assert_eq!((preview.width, preview.height), (100, 50));
        assert_eq!(preview.base_rgba.len(), 100 * 50 * 4);
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
        let pipeline = ColorPipeline::new(0.0, lut).unwrap();
        assert!(matches!(
            pipeline.render_preview(&[0; 3], 2, 1, 100),
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
            let preview = pipeline
                .render_preview(
                    &case.pixels,
                    case.width,
                    case.height,
                    case.width.max(case.height),
                )
                .unwrap();
            assert_code_values_close(&case.name, &preview.base_rgba, &case.base_rgba);
            assert_code_values_close(&case.name, &preview.lut_rgba, &case.lut_rgba);

            let rgb16 = pipeline
                .render_rgb16(&case.pixels, case.width, case.height)
                .unwrap();
            assert_code_values_close(&case.name, &rgb16, &case.lut_rgb16);

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
