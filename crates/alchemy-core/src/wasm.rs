use wasm_bindgen::prelude::*;

use crate::image::PreviewSource;
use crate::pipeline::PreviewLayers;
use crate::tiff::Rgb16TiffWriter;
use crate::{AlchemyError, ColorPipeline, Lut3d, ProcessingMode};

#[wasm_bindgen]
/// A parsed CUBE asset reused by browser preview and export work.
pub struct WasmLut {
    parsed: Lut3d,
}

#[wasm_bindgen]
impl WasmLut {
    #[wasm_bindgen(constructor)]
    /// Parses one hash-verified compact LUT asset at the browser boundary.
    pub fn new(bytes: &[u8]) -> std::result::Result<Self, JsError> {
        Ok(Self {
            parsed: Lut3d::from_binary(bytes).map_err(to_js_error)?,
        })
    }

    /// Creates an empty display-sized preview source with this parsed LUT.
    pub fn create_preview_renderer(
        &self,
        source_width: u32,
        source_height: u32,
        max_edge: u32,
    ) -> std::result::Result<PreviewRenderer, JsError> {
        PreviewRenderer::new(source_width, source_height, max_edge, self.parsed.clone())
    }

    /// Replaces a renderer's LUT without transferring its cached source image.
    pub fn apply_to_renderer(&self, renderer: &mut PreviewRenderer) {
        renderer.set_lut(self.parsed.clone());
    }

    /// Returns the LUT edge length for the experimental WebGPU renderer.
    pub fn size(&self) -> u32 {
        self.parsed.size() as u32
    }

    /// Returns the lower CUBE domain bound for the experimental WebGPU renderer.
    pub fn domain_min(&self) -> Vec<f32> {
        self.parsed.domain_min().to_vec()
    }

    /// Returns the upper CUBE domain bound for the experimental WebGPU renderer.
    pub fn domain_max(&self) -> Vec<f32> {
        self.parsed.domain_max().to_vec()
    }

    /// Returns RGB-interleaved CUBE samples for one GPU upload.
    pub fn samples(&self) -> Vec<f32> {
        self.parsed.flattened_samples()
    }

    /// Creates a strip encoder with this parsed LUT.
    pub fn create_tiff_encoder(
        &self,
        width: u32,
        height: u32,
        ev: f32,
    ) -> std::result::Result<TiffEncoder, JsError> {
        TiffEncoder::new(width, height, ev, self.parsed.clone())
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

    pub fn render(
        &self,
        ev: f32,
        max_edge: u32,
        include_base: bool,
    ) -> std::result::Result<WasmPreview, JsError> {
        let pipeline = ColorPipeline::new(ev, ProcessingMode::CorrectedV2, self.lut.clone())
            .map_err(to_js_error)?;
        let (width, height) = self.source.dimensions();
        let preview = pipeline
            .render_preview_layers(
                self.source.pixels().map_err(to_js_error)?,
                width,
                height,
                max_edge,
                if include_base {
                    PreviewLayers::BaseAndLut
                } else {
                    PreviewLayers::Lut
                },
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

    pub fn render_strip(&mut self, pixels: &[u16]) -> std::result::Result<(), JsError> {
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
        Ok(())
    }

    /// Copies the last CPU-rendered strip for experimental GPU parity checks.
    pub fn rendered_strip(&self) -> Vec<u16> {
        self.output.clone()
    }

    /// Writes an externally rendered RGB16 strip without applying color again.
    pub fn write_rendered_strip(&mut self, pixels: &[u16]) -> std::result::Result<(), JsError> {
        let expected = self.writer.next_strip_samples();
        if pixels.len() != expected {
            return Err(to_js_error(AlchemyError::InvalidPixelCount {
                actual: pixels.len(),
                expected,
            }));
        }
        self.writer.write_strip(pixels).map_err(to_js_error)
    }

    pub fn write_strip(&mut self) -> std::result::Result<(), JsError> {
        let expected = self.writer.next_strip_samples();
        if self.output.len() != expected {
            return Err(to_js_error(AlchemyError::InvalidPixelCount {
                actual: self.output.len(),
                expected,
            }));
        }
        self.writer.write_strip(&self.output).map_err(to_js_error)?;
        self.output.clear();
        Ok(())
    }

    pub fn finish(self) -> std::result::Result<Vec<u8>, JsError> {
        self.writer.finish().map_err(to_js_error)
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
