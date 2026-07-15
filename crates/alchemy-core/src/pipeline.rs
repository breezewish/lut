use crate::color::{
    PROPHOTO_D65_TO_V_GAMUT, encode_v_log, multiply_legacy_matrix, multiply_matrix, render_base,
};
use crate::{AlchemyError, Lut3d, Result, tiff};

/// Versioned processing behavior. Corrected V2 is the canonical product mode.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessingMode {
    /// Explicit D65 input, no creative boost, negative-preserving V-Log.
    #[default]
    CorrectedV2,
    /// Migration-only mode that keeps the legacy saturation/contrast boost.
    LegacyPythonV1,
}

/// Immutable processing recipe shared by preview and export.
#[derive(Clone, Debug)]
pub struct ColorPipeline {
    exposure_multiplier: f32,
    mode: ProcessingMode,
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
    /// Returns [`AlchemyError::InvalidExposure`] when EV is not finite or is
    /// outside the supported range.
    pub fn new(ev: f32, mode: ProcessingMode, lut: Lut3d) -> Result<Self> {
        if !ev.is_finite() || !(-8.0..=8.0).contains(&ev) {
            return Err(AlchemyError::InvalidExposure);
        }
        Ok(Self {
            exposure_multiplier: ev.exp2(),
            mode,
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
        if max_edge == 0 {
            return Err(AlchemyError::InvalidPreviewSize);
        }
        let scale = (f64::from(max_edge) / f64::from(width.max(height))).min(1.0);
        let output_width = (f64::from(width) * scale).round().max(1.0) as u32;
        let output_height = (f64::from(height) * scale).round().max(1.0) as u32;
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
                write_rgba(&mut base_rgba[target..target + 4], render_base(linear));
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
        for input in pixels.chunks_exact(3) {
            output.extend(
                self.render_lut(self.input_pixel(input))
                    .map(|value| quantize_u16(value, self.mode)),
            );
        }
        Ok(output)
    }

    /// Renders and Deflate-compresses a 16-bit RGB TIFF. Processing is fused
    /// per pixel, so no full-size float image is retained.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid image input or encoder failure.
    pub fn render_tiff(&self, pixels: &[u16], width: u32, height: u32) -> Result<Vec<u8>> {
        let output = self.render_rgb16(pixels, width, height)?;
        tiff::encode_rgb16(width, height, &output)
    }

    fn input_pixel(&self, input: &[u16]) -> [f32; 3] {
        let linear = [
            f32::from(input[0]) / 65_535.0 * self.exposure_multiplier,
            f32::from(input[1]) / 65_535.0 * self.exposure_multiplier,
            f32::from(input[2]) / 65_535.0 * self.exposure_multiplier,
        ];
        match self.mode {
            ProcessingMode::CorrectedV2 => linear,
            ProcessingMode::LegacyPythonV1 => legacy_boost(linear),
        }
    }

    fn render_lut(&self, linear_prophoto: [f32; 3]) -> [f32; 3] {
        let mut linear_v_gamut = match self.mode {
            ProcessingMode::CorrectedV2 => {
                multiply_matrix(&PROPHOTO_D65_TO_V_GAMUT, linear_prophoto)
            }
            ProcessingMode::LegacyPythonV1 => multiply_legacy_matrix(linear_prophoto),
        };
        if self.mode == ProcessingMode::LegacyPythonV1 {
            linear_v_gamut = linear_v_gamut.map(|channel| channel.max(1.0e-6));
        }
        let vlog = linear_v_gamut.map(encode_v_log);
        match self.mode {
            ProcessingMode::CorrectedV2 => self.lut.sample(vlog),
            ProcessingMode::LegacyPythonV1 => self.lut.sample_legacy(vlog),
        }
    }
}

fn validate_image(pixels: &[u16], width: u32, height: u32) -> Result<()> {
    let pixel_count = checked_pixel_count(width, height)?;
    let expected = pixel_count
        .checked_mul(3)
        .ok_or(AlchemyError::ImageTooLarge)?;
    if pixels.len() != expected {
        return Err(AlchemyError::InvalidPixelCount {
            actual: pixels.len(),
            expected,
        });
    }
    Ok(())
}

fn checked_pixel_count(width: u32, height: u32) -> Result<usize> {
    if width == 0 || height == 0 {
        return Err(AlchemyError::EmptyImage);
    }
    (width as usize)
        .checked_mul(height as usize)
        .ok_or(AlchemyError::ImageTooLarge)
}

fn legacy_boost(rgb: [f32; 3]) -> [f32; 3] {
    let luminance = 0.288f32.mul_add(rgb[0], 0.7119f32.mul_add(rgb[1], 0.0001 * rgb[2]));
    rgb.map(|channel| {
        let saturated = luminance + 1.25 * (channel - luminance);
        (0.18 + 1.1 * (saturated - 0.18)).max(0.0)
    })
}

fn write_rgba(output: &mut [u8], rgb: [f32; 3]) {
    for channel in 0..3 {
        output[channel] = quantize_u8(rgb[channel]);
    }
    output[3] = 255;
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn quantize_u8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn quantize_u16(value: f32, mode: ProcessingMode) -> u16 {
    let scaled = value.clamp(0.0, 1.0) * 65_535.0;
    match mode {
        ProcessingMode::CorrectedV2 => scaled.round() as u16,
        ProcessingMode::LegacyPythonV1 => scaled as u16,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY_2: &str =
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

    #[test]
    fn exposure_is_applied_to_both_views() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let zero = ColorPipeline::new(0.0, ProcessingMode::CorrectedV2, lut.clone()).unwrap();
        let plus_one = ColorPipeline::new(1.0, ProcessingMode::CorrectedV2, lut).unwrap();
        let pixels = [8_000, 10_000, 12_000];
        let base_zero = zero.render_preview(&pixels, 1, 1, 1).unwrap();
        let base_plus_one = plus_one.render_preview(&pixels, 1, 1, 1).unwrap();
        assert!(base_plus_one.base_rgba[1] > base_zero.base_rgba[1]);
        assert!(base_plus_one.lut_rgba[1] > base_zero.lut_rgba[1]);
    }

    #[test]
    fn preview_downsamples_without_changing_aspect_ratio() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::CorrectedV2, lut).unwrap();
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
            ColorPipeline::new(f32::NAN, ProcessingMode::CorrectedV2, lut.clone()).unwrap_err(),
            AlchemyError::InvalidExposure
        );
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::CorrectedV2, lut).unwrap();
        assert!(matches!(
            pipeline.render_preview(&[0; 3], 2, 1, 100),
            Err(AlchemyError::InvalidPixelCount { .. })
        ));
    }

    #[test]
    fn quantization_rounds_and_clamps_explicitly() {
        assert_eq!(quantize_u16(-1.0, ProcessingMode::CorrectedV2), 0);
        assert_eq!(quantize_u16(0.5, ProcessingMode::CorrectedV2), 32_768);
        assert_eq!(quantize_u16(0.5, ProcessingMode::LegacyPythonV1), 32_767);
        assert_eq!(quantize_u16(2.0, ProcessingMode::CorrectedV2), 65_535);
    }

    #[test]
    fn legacy_mode_matches_frozen_python_checkpoints() {
        use std::io::Cursor;

        use ndarray::Array3;
        use ndarray_npy::NpzReader;

        const BASELINE: &[u8] =
            include_bytes!("../../../baselines/legacy-python-v1/linear-classic-negative-ev0.npz");
        const RAW: &[u8] = include_bytes!("../../../tests/fixtures/linear.dng");
        const CUBE: &str = include_str!(
            "../../../vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube"
        );

        let mut baseline = NpzReader::new(Cursor::new(BASELINE)).unwrap();
        let decoded_expected: Array3<u16> = baseline.by_name("rgb16").unwrap();
        let exposure_expected: Array3<f32> = baseline.by_name("exposure").unwrap();
        let boost_expected: Array3<f32> = baseline.by_name("boost").unwrap();
        let gamut_expected: Array3<f32> = baseline.by_name("gamut").unwrap();
        let vlog_expected: Array3<f64> = baseline.by_name("vlog").unwrap();
        let lut_expected: Array3<f32> = baseline.by_name("lut").unwrap();
        let final_expected: Array3<u16> = baseline.by_name("final_uint16").unwrap();

        let decoded = alchemy_libraw::decode(RAW, false).unwrap();
        let decoded_expected = decoded_expected.as_slice().unwrap();
        let decode_differences: Vec<_> = decoded
            .pixels
            .iter()
            .zip(decoded_expected)
            .enumerate()
            .filter(|(_, (actual, expected))| actual != expected)
            .collect();
        assert!(
            decode_differences.is_empty(),
            "{} decoded samples differ; first={:?}",
            decode_differences.len(),
            decode_differences.first()
        );

        let lut = Lut3d::parse(CUBE).unwrap();
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::LegacyPythonV1, lut).unwrap();
        let exposure_expected = exposure_expected.as_slice().unwrap();
        let boost_expected = boost_expected.as_slice().unwrap();
        let gamut_expected = gamut_expected.as_slice().unwrap();
        let vlog_expected = vlog_expected.as_slice().unwrap();
        let lut_expected = lut_expected.as_slice().unwrap();

        for (pixel_index, input) in decoded.pixels.chunks_exact(3).enumerate() {
            let offset = pixel_index * 3;
            let exposure = [
                f32::from(input[0]) / 65_535.0,
                f32::from(input[1]) / 65_535.0,
                f32::from(input[2]) / 65_535.0,
            ];
            assert_channels_close(
                "exposure",
                exposure,
                &exposure_expected[offset..offset + 3],
                1.0e-7,
            );
            let boost = pipeline.input_pixel(input);
            assert_channels_close("boost", boost, &boost_expected[offset..offset + 3], 2.0e-6);
            let gamut = multiply_legacy_matrix(boost);
            assert_channels_close("gamut", gamut, &gamut_expected[offset..offset + 3], 2.0e-6);
            let vlog = gamut.map(|channel| encode_v_log(channel.max(1.0e-6)));
            for channel in 0..3 {
                assert!(
                    (f64::from(vlog[channel]) - vlog_expected[offset + channel]).abs() <= 2.0e-6
                );
            }
            let output = pipeline.lut.sample_legacy(vlog);
            assert_channels_close("lut", output, &lut_expected[offset..offset + 3], 2.0e-6);
        }

        let actual = pipeline
            .render_rgb16(&decoded.pixels, decoded.width, decoded.height)
            .unwrap();
        let expected = final_expected.as_slice().unwrap();
        let max_code_difference = actual
            .iter()
            .zip(expected)
            .map(|(actual, expected)| actual.abs_diff(*expected))
            .max()
            .unwrap();
        assert!(
            max_code_difference <= 1,
            "max code difference: {max_code_difference}"
        );
    }

    fn assert_channels_close(label: &str, actual: [f32; 3], expected: &[f32], tolerance: f32) {
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() <= tolerance,
                "{label}: actual={actual:?}, expected={expected:?}"
            );
        }
    }
}
