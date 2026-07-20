//! Browser and native color-processing core for `LUTify`.
//!
//! The input contract is interleaved RGB16 in **`LibRaw` `ProPhoto` D65 Linear**.
//! All exported processing paths preserve that explicit white-point contract.

#[cfg(not(target_arch = "wasm32"))]
mod c_api;
#[cfg(not(target_arch = "wasm32"))]
mod color;
mod cube;
mod error;
mod image;
#[cfg(not(target_arch = "wasm32"))]
mod pipeline;
mod tiff;

#[cfg(not(target_arch = "wasm32"))]
pub use c_api::{LutifyBuffer, LutifyRenderResult, LutifyStatus};
pub use cube::Lut3d;
pub use error::{LutifyError, Result};
#[cfg(not(target_arch = "wasm32"))]
pub use pipeline::ColorPipeline;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
