use crate::color::{
    LIBRAW_PROPHOTO_D65_TO_V_GAMUT, encode_v_log, legacy_bt709_to_srgb, multiply_legacy_matrix,
    multiply_matrix, render_base_preview,
};
use crate::image::{checked_pixel_count, preview_dimensions};
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

#[derive(Clone, Copy, Eq, PartialEq)]
#[cfg_attr(not(feature = "wasm"), allow(dead_code))]
pub(crate) enum PreviewLayers {
    BaseAndLut,
    Lut,
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
        self.render_preview_layers(pixels, width, height, max_edge, PreviewLayers::BaseAndLut)
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    pub(crate) fn render_preview_layers(
        &self,
        pixels: &[u16],
        width: u32,
        height: u32,
        max_edge: u32,
        layers: PreviewLayers,
    ) -> Result<Preview> {
        validate_image(pixels, width, height)?;
        let (output_width, output_height) = preview_dimensions(width, height, max_edge)?;
        let output_pixels = checked_pixel_count(output_width, output_height)?;
        let mut base_rgba = match layers {
            PreviewLayers::BaseAndLut => vec![0; output_pixels * 4],
            PreviewLayers::Lut => Vec::new(),
        };
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
                if layers == PreviewLayers::BaseAndLut {
                    write_rgba8(
                        &mut base_rgba[target..target + 4],
                        render_base_preview(linear),
                    );
                }
                let lut = self.render_lut(linear);
                let display = match self.mode {
                    ProcessingMode::CorrectedV2 => lut,
                    ProcessingMode::LegacyPythonV1 => lut.map(legacy_bt709_to_srgb),
                };
                write_rgba(&mut lut_rgba[target..target + 4], display);
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
            output.extend(
                self.render_lut(self.input_pixel(input))
                    .map(|value| quantize_u16(value, self.mode)),
            );
        }
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

    fn render_lut(&self, linear_libraw_prophoto: [f32; 3]) -> [f32; 3] {
        let mut linear_v_gamut = match self.mode {
            ProcessingMode::CorrectedV2 => {
                multiply_matrix(&LIBRAW_PROPHOTO_D65_TO_V_GAMUT, linear_libraw_prophoto)
            }
            ProcessingMode::LegacyPythonV1 => multiply_legacy_matrix(linear_libraw_prophoto),
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

pub(crate) fn validate_image(pixels: &[u16], width: u32, height: u32) -> Result<()> {
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

fn write_rgba8(output: &mut [u8], rgb: [u8; 3]) {
    output[..3].copy_from_slice(&rgb);
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
    use std::io::Cursor;
    use std::path::Path;

    use ::tiff::{
        ColorType,
        decoder::{Decoder, DecodingResult},
        tags::CompressionMethod,
    };
    use ndarray::{Array3, Array4, Axis};
    use ndarray_npy::NpzReader;
    use serde::Deserialize;

    use super::*;

    const IDENTITY_2: &str =
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    const HALF_GRAY_2: &str = "LUT_3D_SIZE 2\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n0.5 0.5 0.5\n";
    const LEGACY_BASELINE: &[u8] =
        include_bytes!("../../../baselines/legacy-python-v1/linear-all-looks-ev0.npz");
    const CORRECTED_REFERENCE: &str =
        include_str!("../../../tests/fixtures/corrected-v2-reference.json");
    const RAW: &[u8] = include_bytes!("../../../tests/fixtures/linear.dng");
    const LUT_MANIFEST: &str = include_str!("../../../assets/luts.json");

    #[derive(Deserialize)]
    struct LutManifest {
        luts: Vec<LutAsset>,
    }

    #[derive(Deserialize)]
    struct LutAsset {
        id: String,
        file: String,
    }

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
    fn legacy_preview_converts_bt709_lut_output_to_srgb() {
        let lut = Lut3d::parse(HALF_GRAY_2).unwrap();
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::LegacyPythonV1, lut).unwrap();
        let preview = pipeline.render_preview(&[32_768; 3], 1, 1, 1).unwrap();

        // The frozen Python preview decodes 0.5 as BT.709 and re-encodes it as sRGB.
        assert_eq!(&preview.lut_rgba[..3], &[139, 139, 139]);
    }

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
    fn exposure_supports_both_documented_boundaries() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let minimum = ColorPipeline::new(-8.0, ProcessingMode::CorrectedV2, lut.clone()).unwrap();
        let maximum = ColorPipeline::new(8.0, ProcessingMode::CorrectedV2, lut).unwrap();
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
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::CorrectedV2, lut).unwrap();
        let preview = pipeline
            .render_preview(&vec![0; 400 * 200 * 3], 400, 200, 100)
            .unwrap();
        assert_eq!((preview.width, preview.height), (100, 50));
        assert_eq!(preview.base_rgba.len(), 100 * 50 * 4);
    }

    #[test]
    fn lut_only_preview_skips_the_unchanged_base_layer() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let pipeline = ColorPipeline::new(0.0, ProcessingMode::CorrectedV2, lut).unwrap();
        let preview = pipeline
            .render_preview_layers(
                &vec![32_768; 400 * 200 * 3],
                400,
                200,
                100,
                PreviewLayers::Lut,
            )
            .unwrap();

        assert_eq!((preview.width, preview.height), (100, 50));
        assert!(preview.base_rgba.is_empty());
        assert_eq!(preview.lut_rgba.len(), 100 * 50 * 4);
    }

    #[test]
    fn rejects_invalid_dimensions_and_exposure() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        assert_eq!(
            ColorPipeline::new(f32::NAN, ProcessingMode::CorrectedV2, lut.clone()).unwrap_err(),
            AlchemyError::InvalidExposure
        );
        assert_eq!(
            ColorPipeline::new(f32::INFINITY, ProcessingMode::CorrectedV2, lut.clone())
                .unwrap_err(),
            AlchemyError::InvalidExposure
        );
        assert_eq!(
            ColorPipeline::new(8.1, ProcessingMode::CorrectedV2, lut.clone()).unwrap_err(),
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
    fn corrected_pipeline_matches_independent_float64_reference() {
        let reference: CorrectedReference = serde_json::from_str(CORRECTED_REFERENCE).unwrap();
        assert_eq!(reference.schema_version, 1);
        let lut = Lut3d::parse(&reference.cube).unwrap();

        for case in reference.cases {
            let pipeline =
                ColorPipeline::new(case.ev, ProcessingMode::CorrectedV2, lut.clone()).unwrap();
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

    #[test]
    fn legacy_common_stages_match_frozen_python_checkpoints() {
        let mut baseline = NpzReader::new(Cursor::new(LEGACY_BASELINE)).unwrap();
        let decoded_expected: Array3<u16> = baseline.by_name("rgb16").unwrap();
        let exposure_expected: Array3<f32> = baseline.by_name("exposure").unwrap();
        let boost_expected: Array3<f32> = baseline.by_name("boost").unwrap();
        let gamut_expected: Array3<f32> = baseline.by_name("gamut").unwrap();
        let vlog_expected: Array3<f64> = baseline.by_name("vlog").unwrap();

        let decoded = alchemy_libraw::decode(RAW, false).unwrap();
        let decoded_expected = decoded_expected.as_slice().unwrap();
        let first_decode_difference = decoded
            .pixels
            .iter()
            .zip(decoded_expected)
            .position(|(actual, expected)| actual != expected);
        assert!(
            first_decode_difference.is_none(),
            "decoded RGB16 first differs at sample {first_decode_difference:?}"
        );

        let exposure_expected = exposure_expected.as_slice().unwrap();
        let boost_expected = boost_expected.as_slice().unwrap();
        let gamut_expected = gamut_expected.as_slice().unwrap();
        let vlog_expected = vlog_expected.as_slice().unwrap();
        let stage_lut = Lut3d::parse(IDENTITY_2).unwrap();
        let stage_pipeline =
            ColorPipeline::new(0.0, ProcessingMode::LegacyPythonV1, stage_lut).unwrap();

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
            let boost = stage_pipeline.input_pixel(input);
            assert_channels_close("boost", boost, &boost_expected[offset..offset + 3], 2.0e-6);
            let gamut = multiply_legacy_matrix(boost);
            assert_channels_close("gamut", gamut, &gamut_expected[offset..offset + 3], 2.0e-6);
            let vlog = gamut.map(|channel| encode_v_log(channel.max(1.0e-6)));
            for channel in 0..3 {
                assert!(
                    (f64::from(vlog[channel]) - vlog_expected[offset + channel]).abs() <= 2.0e-6
                );
            }
        }
    }

    #[test]
    fn legacy_exports_match_frozen_python_for_all_luts() {
        let mut baseline = NpzReader::new(Cursor::new(LEGACY_BASELINE)).unwrap();
        let lut_expected: Array4<f32> = baseline.by_name("lut_outputs").unwrap();
        let final_expected: Array4<u16> = baseline.by_name("final_uint16").unwrap();
        let lut_manifest: LutManifest = serde_json::from_str(LUT_MANIFEST).unwrap();
        let decoded = alchemy_libraw::decode(RAW, false).unwrap();

        assert_eq!(lut_manifest.luts.len(), lut_expected.len_of(Axis(0)));
        assert_eq!(lut_manifest.luts.len(), final_expected.len_of(Axis(0)));
        let lut_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/V-Log-Alchemy/Luts");

        for (look_index, look) in lut_manifest.luts.iter().enumerate() {
            let cube = std::fs::read_to_string(lut_root.join(&look.file)).unwrap();
            let lut = Lut3d::parse(&cube).unwrap();
            let pipeline = ColorPipeline::new(0.0, ProcessingMode::LegacyPythonV1, lut).unwrap();
            let expected_lut = lut_expected.index_axis(Axis(0), look_index);
            let expected_lut = expected_lut.as_slice().unwrap();

            for (pixel_index, input) in decoded.pixels.chunks_exact(3).enumerate() {
                let offset = pixel_index * 3;
                let output = pipeline.render_lut(pipeline.input_pixel(input));
                assert_channels_close(
                    &format!("{} LUT", look.id),
                    output,
                    &expected_lut[offset..offset + 3],
                    2.0e-6,
                );
            }

            let actual = pipeline
                .render_rgb16(&decoded.pixels, decoded.width, decoded.height)
                .unwrap();
            let expected = final_expected.index_axis(Axis(0), look_index);
            let max_code_difference = actual
                .iter()
                .zip(expected.iter())
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(
                max_code_difference <= 1,
                "{} export max code difference: {max_code_difference}",
                look.id
            );
        }
    }

    #[test]
    fn legacy_previews_match_frozen_python_for_all_luts() {
        let mut baseline = NpzReader::new(Cursor::new(LEGACY_BASELINE)).unwrap();
        let decoded_expected: Array3<u16> = baseline.by_name("preview_rgb16").unwrap();
        let preview_expected: Array4<f32> = baseline.by_name("preview_srgb").unwrap();
        let lut_manifest: LutManifest = serde_json::from_str(LUT_MANIFEST).unwrap();
        let decoded = alchemy_libraw::decode(RAW, true).unwrap();

        assert_eq!(decoded.pixels, decoded_expected.as_slice().unwrap());
        assert_eq!(lut_manifest.luts.len(), preview_expected.len_of(Axis(0)));
        let lut_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/V-Log-Alchemy/Luts");

        for (look_index, look) in lut_manifest.luts.iter().enumerate() {
            let cube = std::fs::read_to_string(lut_root.join(&look.file)).unwrap();
            let lut = Lut3d::parse(&cube).unwrap();
            let pipeline = ColorPipeline::new(0.0, ProcessingMode::LegacyPythonV1, lut).unwrap();
            let preview = pipeline
                .render_preview(
                    &decoded.pixels,
                    decoded.width,
                    decoded.height,
                    decoded.width.max(decoded.height),
                )
                .unwrap();
            let expected = preview_expected.index_axis(Axis(0), look_index);
            let expected = expected.as_slice().unwrap();
            let max_preview_difference = preview
                .lut_rgba
                .chunks_exact(4)
                .zip(expected.chunks_exact(3))
                .flat_map(|(actual, expected)| {
                    actual[..3]
                        .iter()
                        .zip(expected)
                        .map(|(actual, expected)| actual.abs_diff(quantize_u8(*expected)))
                })
                .max()
                .unwrap();
            assert!(
                max_preview_difference <= 1,
                "{} preview max code difference: {max_preview_difference}",
                look.id
            );
        }
    }

    fn assert_channels_close(label: &str, actual: [f32; 3], expected: &[f32], tolerance: f32) {
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() <= tolerance,
                "{label}: actual={actual:?}, expected={expected:?}"
            );
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
