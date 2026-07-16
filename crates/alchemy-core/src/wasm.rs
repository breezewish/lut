use wasm_bindgen::prelude::*;

use crate::image::PreviewSource;
use crate::tiff::Rgb16TiffWriter;
use crate::{AlchemyError, ColorPipeline, Lut3d, ProcessingMode};

#[wasm_bindgen]
/// A hash-verified CUBE upload that is parsed once and reused by browser work.
pub struct WasmLut {
    bytes: Vec<u8>,
    written_len: usize,
    parsed: Option<Lut3d>,
}

#[wasm_bindgen]
impl WasmLut {
    #[wasm_bindgen(constructor)]
    /// Allocates the exact byte length declared by the verified browser asset.
    pub fn new(expected_len: usize) -> Self {
        Self {
            bytes: vec![0; expected_len],
            written_len: 0,
            parsed: None,
        }
    }

    /// Appends the next one-to-four CUBE bytes packed in little-endian order.
    ///
    /// Scalar arguments intentionally avoid `wasm-bindgen`'s typed-array copy
    /// path, which intermittently corrupts large inputs in `WebKit`. Four bytes
    /// per call bound the overhead without reintroducing that browser boundary.
    pub fn write_word(
        &mut self,
        offset: usize,
        word: u32,
        length: usize,
    ) -> std::result::Result<(), JsError> {
        if self.parsed.is_some()
            || offset != self.written_len
            || !(1..=4).contains(&length)
            || length > self.bytes.len().saturating_sub(offset)
        {
            return Err(JsError::new("CUBE upload words must be contiguous"));
        }
        self.bytes[offset..offset + length].copy_from_slice(&word.to_le_bytes()[..length]);
        self.written_len += length;
        Ok(())
    }

    /// Validates the completed upload and parses its CUBE data exactly once.
    pub fn finish(&mut self) -> std::result::Result<(), JsError> {
        if self.parsed.is_some() || self.written_len != self.bytes.len() {
            return Err(JsError::new("CUBE upload is incomplete"));
        }
        self.parsed = Some(parse_lut(&self.bytes)?);
        self.bytes = Vec::new();
        Ok(())
    }

    /// Creates an empty display-sized preview source with this parsed LUT.
    pub fn create_preview_renderer(
        &self,
        source_width: u32,
        source_height: u32,
        max_edge: u32,
    ) -> std::result::Result<PreviewRenderer, JsError> {
        PreviewRenderer::new(
            source_width,
            source_height,
            max_edge,
            self.parsed()?.clone(),
        )
    }

    /// Replaces a renderer's LUT without transferring its cached source image.
    pub fn apply_to_renderer(
        &self,
        renderer: &mut PreviewRenderer,
    ) -> std::result::Result<(), JsError> {
        renderer.set_lut(self.parsed()?.clone());
        Ok(())
    }

    /// Creates a strip encoder with this parsed LUT.
    pub fn create_tiff_encoder(
        &self,
        width: u32,
        height: u32,
        ev: f32,
    ) -> std::result::Result<TiffEncoder, JsError> {
        TiffEncoder::new(width, height, ev, self.parsed()?.clone())
    }
}

impl WasmLut {
    fn parsed(&self) -> std::result::Result<&Lut3d, JsError> {
        self.parsed
            .as_ref()
            .ok_or_else(|| JsError::new("CUBE upload is not finished"))
    }
}

#[wasm_bindgen]
pub struct WasmPreview {
    width: u32,
    height: u32,
    base: Vec<u8>,
    lut: Vec<u8>,
}

#[wasm_bindgen]
impl WasmPreview {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn take_base_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.base)
    }

    pub fn take_lut_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.lut)
    }
}

#[wasm_bindgen]
pub struct PreviewRenderer {
    source: PreviewSource,
    lut: Lut3d,
}

impl PreviewRenderer {
    fn new(
        source_width: u32,
        source_height: u32,
        max_edge: u32,
        lut: Lut3d,
    ) -> std::result::Result<Self, JsError> {
        let source =
            PreviewSource::new(source_width, source_height, max_edge).map_err(to_js_error)?;
        Ok(Self { source, lut })
    }

    fn set_lut(&mut self, lut: Lut3d) {
        self.lut = lut;
    }
}

#[wasm_bindgen]
impl PreviewRenderer {
    /// Returns the next decoded source row required by the preview.
    pub fn next_source_row(&self) -> Option<u32> {
        self.source.next_source_row()
    }

    /// Resamples one requested decoded RGB16 source row into the preview cache.
    pub fn write_source_row(&mut self, pixels: &[u16]) -> std::result::Result<(), JsError> {
        self.source.write_source_row(pixels).map_err(to_js_error)
    }

    pub fn render(&self, ev: f32) -> std::result::Result<WasmPreview, JsError> {
        let pipeline = ColorPipeline::new(ev, ProcessingMode::CorrectedV2, self.lut.clone())
            .map_err(to_js_error)?;
        let (width, height) = self.source.dimensions();
        let preview = pipeline
            .render_preview(
                self.source.pixels().map_err(to_js_error)?,
                width,
                height,
                width.max(height),
            )
            .map_err(to_js_error)?;
        Ok(WasmPreview {
            width: preview.width,
            height: preview.height,
            base: preview.base_rgba,
            lut: preview.lut_rgba,
        })
    }
}

#[wasm_bindgen]
pub struct TiffEncoder {
    pipeline: ColorPipeline,
    writer: Rgb16TiffWriter,
    output: Vec<u16>,
}

impl TiffEncoder {
    fn new(width: u32, height: u32, ev: f32, lut: Lut3d) -> std::result::Result<Self, JsError> {
        let pipeline =
            ColorPipeline::new(ev, ProcessingMode::CorrectedV2, lut).map_err(to_js_error)?;
        let writer = Rgb16TiffWriter::new(width, height).map_err(to_js_error)?;
        Ok(Self {
            pipeline,
            writer,
            output: Vec::new(),
        })
    }
}

#[wasm_bindgen]
impl TiffEncoder {
    pub fn next_strip_samples(&self) -> usize {
        self.writer.next_strip_samples()
    }

    pub fn write_strip(&mut self, pixels: &[u16]) -> std::result::Result<(), JsError> {
        let expected = self.writer.next_strip_samples();
        if pixels.len() != expected {
            return Err(to_js_error(AlchemyError::InvalidPixelCount {
                actual: pixels.len(),
                expected,
            }));
        }
        self.output.clear();
        self.output.reserve(expected);
        self.pipeline.render_rgb16_strip(pixels, &mut self.output);
        self.writer.write_strip(&self.output).map_err(to_js_error)
    }

    pub fn finish(self) -> std::result::Result<Vec<u8>, JsError> {
        self.writer.finish().map_err(to_js_error)
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn parse_lut(cube: &[u8]) -> std::result::Result<Lut3d, JsError> {
    let source =
        std::str::from_utf8(cube).map_err(|_| JsError::new("CUBE source must be valid UTF-8"))?;
    Lut3d::parse(source).map_err(to_js_error)
}
