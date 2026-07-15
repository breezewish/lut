use wasm_bindgen::prelude::*;

use crate::{ColorPipeline, Lut3d, ProcessingMode};

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

    pub fn base_rgba(&self) -> Vec<u8> {
        self.base.clone()
    }

    pub fn lut_rgba(&self) -> Vec<u8> {
        self.lut.clone()
    }
}

#[wasm_bindgen]
pub fn render_preview(
    pixels: &[u16],
    width: u32,
    height: u32,
    ev: f32,
    cube: &str,
    max_edge: u32,
) -> std::result::Result<WasmPreview, JsError> {
    let lut = Lut3d::parse(cube).map_err(to_js_error)?;
    let pipeline = ColorPipeline::new(ev, ProcessingMode::CorrectedV2, lut).map_err(to_js_error)?;
    let preview = pipeline
        .render_preview(pixels, width, height, max_edge)
        .map_err(to_js_error)?;
    Ok(WasmPreview {
        width: preview.width,
        height: preview.height,
        base: preview.base_rgba,
        lut: preview.lut_rgba,
    })
}

#[wasm_bindgen]
pub fn render_tiff(
    pixels: &[u16],
    width: u32,
    height: u32,
    ev: f32,
    cube: &str,
) -> std::result::Result<Vec<u8>, JsError> {
    let lut = Lut3d::parse(cube).map_err(to_js_error)?;
    let pipeline = ColorPipeline::new(ev, ProcessingMode::CorrectedV2, lut).map_err(to_js_error)?;
    pipeline
        .render_tiff(pixels, width, height)
        .map_err(to_js_error)
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
