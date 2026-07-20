//! Browser and native color-processing core for `LUTify`.
//!
//! The input contract is interleaved RGB16 in **`LibRaw` `ProPhoto` D65 Linear**.
//! All exported processing paths preserve that explicit white-point contract.

mod c_api;
mod color;
mod cube;
mod error;
mod image;
mod pipeline;
mod tiff;

pub use c_api::{LutifyBuffer, LutifyRenderResult, LutifyStatus};
pub use cube::Lut3d;
pub use error::{LutifyError, Result};
pub use pipeline::{ColorPipeline, Preview};

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;

/// Encodes a linear V-Gamut channel using Panasonic's published V-Log curve.
///
/// Values below the 0.01 breakpoint use the linear branch, so negative matrix
/// results remain meaningful instead of being clipped before encoding.
#[must_use]
pub fn encode_v_log(linear: f32) -> f32 {
    color::encode_v_log(linear)
}

/// C ABI entry point for the canonical V-Log transfer function.
#[unsafe(no_mangle)]
pub extern "C" fn lutify_encode_v_log(linear: f32) -> f32 {
    encode_v_log(linear)
}
