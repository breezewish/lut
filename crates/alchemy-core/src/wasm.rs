use wasm_bindgen::prelude::*;

use crate::image::PreviewSource;
use crate::tiff::Rgb16TiffWriter;
use crate::{AlchemyError, ColorPipeline, Lut3d, ProcessingMode};

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

#[wasm_bindgen]
impl PreviewRenderer {
    /// Creates an empty display-sized preview source for the decoded image.
    #[wasm_bindgen(constructor)]
    pub fn new(
        source_width: u32,
        source_height: u32,
        max_edge: u32,
        cube: &str,
    ) -> std::result::Result<Self, JsError> {
        let source =
            PreviewSource::new(source_width, source_height, max_edge).map_err(to_js_error)?;
        let lut = Lut3d::parse(cube).map_err(to_js_error)?;
        Ok(Self { source, lut })
    }

    /// Returns the next decoded source row required by the preview.
    pub fn next_source_row(&self) -> Option<u32> {
        self.source.next_source_row()
    }

    /// Resamples one requested decoded RGB16 source row into the preview cache.
    pub fn write_source_row(&mut self, pixels: &[u16]) -> std::result::Result<(), JsError> {
        self.source.write_source_row(pixels).map_err(to_js_error)
    }

    pub fn set_lut(&mut self, cube: &str) -> std::result::Result<(), JsError> {
        self.lut = Lut3d::parse(cube).map_err(to_js_error)?;
        Ok(())
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

#[wasm_bindgen]
impl TiffEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, ev: f32, cube: &str) -> std::result::Result<Self, JsError> {
        let lut = Lut3d::parse(cube).map_err(to_js_error)?;
        let pipeline =
            ColorPipeline::new(ev, ProcessingMode::CorrectedV2, lut).map_err(to_js_error)?;
        let writer = Rgb16TiffWriter::new(width, height).map_err(to_js_error)?;
        Ok(Self {
            pipeline,
            writer,
            output: Vec::new(),
        })
    }

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
