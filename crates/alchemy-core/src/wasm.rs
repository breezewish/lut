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

    /// Returns the LUT edge length for the WebGPU renderer.
    pub fn size(&self) -> u32 {
        u32::try_from(self.parsed.size()).expect("LUT size is capped at 129")
    }

    /// Returns the lower CUBE domain bound for the WebGPU renderer.
    pub fn domain_min(&self) -> Vec<f32> {
        self.parsed.domain_min().to_vec()
    }

    /// Returns the upper CUBE domain bound for the WebGPU renderer.
    pub fn domain_max(&self) -> Vec<f32> {
        self.parsed.domain_max().to_vec()
    }

    /// Returns RGB-interleaved CUBE samples for one GPU upload.
    pub fn samples(&self) -> Vec<f32> {
        self.parsed.flattened_samples()
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

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.source.dimensions().0
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.source.dimensions().1
    }

    /// Moves the completed display-sized RGB16 cache to a GPU renderer.
    pub fn take_source_rgb16(&mut self) -> std::result::Result<Vec<u16>, JsError> {
        self.source.take_pixels().map_err(to_js_error)
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
    writer: Rgb16TiffWriter,
}

#[wasm_bindgen]
impl TiffEncoder {
    #[wasm_bindgen(constructor)]
    /// Creates a TIFF encoder for RGB16 strips already rendered by WebGPU.
    pub fn new(width: u32, height: u32) -> std::result::Result<Self, JsError> {
        Ok(Self {
            writer: Rgb16TiffWriter::new(width, height).map_err(to_js_error)?,
        })
    }

    pub fn next_strip_samples(&self) -> usize {
        self.writer.next_strip_samples()
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

    pub fn finish(self) -> std::result::Result<Vec<u8>, JsError> {
        self.writer.finish().map_err(to_js_error)
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
